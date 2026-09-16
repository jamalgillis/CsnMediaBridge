#![recursion_limit = "256"]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    settings: Mutex<Value>,
    jobs: Mutex<Vec<Value>>,
    logs: Mutex<Vec<Value>>,
    live_handoff_jobs: Mutex<Vec<Value>>,
    media_proxy_origin: Mutex<Option<String>>,
    /// The most recent offload snapshot, so a screen opened mid-copy shows the
    /// copy rather than an empty page.
    offload_task: Mutex<Option<Value>>,
    offload_running: Arc<AtomicBool>,
    /// A station converts one live recording at a time. Held by whichever path
    /// claimed it — the automatic loop or an operator's Convert — so the two
    /// can never claim at once and double the download.
    live_handoff_running: Arc<AtomicBool>,
    /// Recordings being archived from Stream or saved to this machine, newest
    /// first, so the library screen can show progress after it is reopened.
    stream_transfers: Mutex<Vec<Value>>,
    /// One stop flag per transfer, keyed by Stream video uid.
    stream_transfer_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    offload_pause: Arc<AtomicBool>,
    offload_cancel: Arc<AtomicBool>,
    watching: Arc<AtomicBool>,
    /// The update found by the last check, held so installing does not have to
    /// go back to the feed.
    pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// The signed-in operator, if any. Holds tokens, so it never reaches the
    /// renderer whole — see `auth_public_snapshot`.
    auth_session: Mutex<Option<Value>>,
    /// The most recent update status, so the state snapshot can report it.
    app_update: Mutex<Option<Value>>,
}

const APP_CONFIG_DIR_NAME: &str = "CSN Media Bridge";
const SETTINGS_FILE_NAME: &str = "settings.json";
const NODE_KEY_FILE_NAME: &str = "node-key.txt";
#[cfg(not(test))]
const KEYCHAIN_SERVICE: &str = "com.gfamagency.mediabridge";
const AUTH_SESSION_KEYCHAIN_ACCOUNT: &str = "auth.session";
const SECRET_SETTING_PATHS: &[(&[&str], &str)] = &[
    (&["b2", "keyId"], "settings.b2.keyId"),
    (&["b2", "applicationKey"], "settings.b2.applicationKey"),
    (&["r2", "accessKeyId"], "settings.r2.accessKeyId"),
    (&["r2", "secretAccessKey"], "settings.r2.secretAccessKey"),
    (&["convex", "nodeToken"], "settings.convex.nodeToken"),
    (&["broker", "token"], "settings.broker.token"),
];
const MAX_JOB_HISTORY: usize = 50;
const MAX_LOG_ENTRIES: usize = 200;
const STATE_UPDATED_EVENT: &str = "media-bridge:state-updated";
const LIVE_HANDOFF_UPDATED_EVENT: &str = "media-bridge:live-stream-handoff-updated";
const HLS_SEGMENT_DURATION_SECONDS: u64 = 2;
const DASH_MANIFEST_FILENAME: &str = "manifest.mpd";
const PROGRESSIVE_H264_FILENAME: &str = "playback-h264.mp4";
const MASTERS_PREFIX: &str = "masters";
const STREAMING_PREFIX: &str = "videos";
const LEGACY_STREAMING_PREFIX: &str = "streaming/vod";
const POSTERS_PREFIX: &str = "posters";
const UNASSIGNED_PROJECT_SEGMENT: &str = "unassigned";
const SUPPORTED_INGEST_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];
const LIVE_HANDOFF_LIST_RECENT_QUERY: &str = "media/liveStream:listRecentHandoffJobs";
const LIVE_HANDOFF_CLAIM_MUTATION: &str = "media/liveStream:claimNextHandoffJob";
const LIVE_HANDOFF_RENEW_MUTATION: &str = "media/liveStream:renewHandoffJobLease";
const LIVE_HANDOFF_PROGRESS_MUTATION: &str = "media/liveStream:markHandoffProgress";
const LIVE_HANDOFF_COMPLETE_MUTATION: &str = "media/liveStream:completeHandoffJob";
const LIVE_HANDOFF_FAILED_MUTATION: &str = "media/liveStream:markHandoffFailed";
/// Claims one chosen recording, for manual Convert. Newer than the others; a
/// deployment without it answers with a missing-function error.
const LIVE_HANDOFF_CLAIM_BY_ID_MUTATION: &str = "media/liveStream:claimHandoffJob";
/// How often the queue is refreshed, and — when this station converts on its
/// own — how often it looks for something to claim.
const LIVE_HANDOFF_POLL_SECONDS: u64 = 60;

struct HlsVariant {
    label: &'static str,
    width: u64,
    height: u64,
    bitrate: &'static str,
    maxrate: &'static str,
    bufsize: &'static str,
}

impl HlsVariant {
    fn rendition_name(&self) -> String {
        format!("{}p_{}", self.label, self.bitrate)
    }
}

const HLS_VARIANTS: &[HlsVariant] = &[
    HlsVariant {
        label: "1080",
        width: 1920,
        height: 1080,
        bitrate: "6000k",
        maxrate: "6420k",
        bufsize: "9000k",
    },
    HlsVariant {
        label: "720",
        width: 1280,
        height: 720,
        bitrate: "3200k",
        maxrate: "3424k",
        bufsize: "4800k",
    },
    HlsVariant {
        label: "480",
        width: 854,
        height: 480,
        bitrate: "1600k",
        maxrate: "1712k",
        bufsize: "2400k",
    },
    HlsVariant {
        label: "360",
        width: 640,
        height: 360,
        bitrate: "850k",
        maxrate: "910k",
        bufsize: "1275k",
    },
];

fn default_settings() -> Value {
    json!({
        "watchFolder": "",
        "tempOutputPath": "",
        "hardwareEncoderOverride": "auto",
        "autoWatch": true,
        "autoCleanupTempFiles": true,
        "autoFallbackToSoftware": true,
        "extractPosterFrame": true,
        "generateScrubThumbnails": true,
        "verifyUploads": true,
        "enableNotifications": true,
        "uploadConcurrency": 10,
        "autoProgressiveMaxDurationSeconds": 60,
        "readyCheckIntervalMs": 2000,
        "readyCheckStablePasses": 3,
        "storage": {
            "layout": "canonical"
        },
        "b2": {
            "bucket": option_env!("CSN_B2_BUCKET").unwrap_or(""),
            "pathPrefix": option_env!("CSN_B2_PATH_PREFIX").unwrap_or("vod/archive"),
            "keyId": "",
            "applicationKey": "",
            "s3Endpoint": option_env!("CSN_B2_S3_ENDPOINT").unwrap_or("")
        },
        "r2": {
            "accountId": option_env!("CSN_R2_ACCOUNT_ID").unwrap_or(""),
            "bucket": option_env!("CSN_R2_BUCKET").unwrap_or(""),
            "pathPrefix": option_env!("CSN_R2_PATH_PREFIX").unwrap_or("vod/hls"),
            "publicBaseUrl": option_env!("CSN_R2_PUBLIC_BASE_URL").unwrap_or(""),
            "accessKeyId": "",
            "secretAccessKey": ""
        },
        "convex": {
            "deploymentUrl": option_env!("CSN_CONVEX_DEPLOYMENT_URL").unwrap_or(""),
            "mutationPath": option_env!("CSN_CONVEX_MUTATION_PATH").unwrap_or("media/videos:createVodEntry"),
            "nodeToken": ""
        },
        "auth": {
            "issuer": option_env!("CLERK_OAUTH_ISSUER").unwrap_or(""),
            "clientId": option_env!("CLERK_OAUTH_CLIENT_ID").unwrap_or("")
        },
        "broker": {
            "url": option_env!("CSN_BROKER_URL").unwrap_or(""),
            "token": "",
            "streamMedia": false
        },
        "offload": {
            "localFolder": "",
            "b2PathPrefix": option_env!("CSN_OFFLOAD_B2_PATH_PREFIX").unwrap_or("offloads"),
            "localCopyMode": "fast",
            "convertImagesToWebp": true,
            "uploadImagesToCloud": false
        },
        "appUpdates": {
            "enabled": !option_env!("APP_UPDATE_BASE_URL").unwrap_or("").is_empty(),
            "baseUrl": option_env!("APP_UPDATE_BASE_URL").unwrap_or(""),
            "checkIntervalMinutes": 60
        },
        "liveRecordings": {
            // Off by default: a station should only start pulling multi-gigabyte
            // recordings once someone has decided it is the one that should.
            "autoConvert": false
        }
    })
}

fn build_state(
    system: Value,
    jobs: Vec<Value>,
    logs: Vec<Value>,
    is_watching: bool,
    app_update: Value,
) -> Value {
    let active_encoding_job_id = jobs
        .iter()
        .find(|job| {
            matches!(
                job.get("status").and_then(Value::as_str),
                Some("encoding" | "uploading" | "registering")
            )
        })
        .and_then(|job| job.get("id").and_then(Value::as_str))
        .map(|id| Value::String(id.to_string()))
        .unwrap_or(Value::Null);

    let queue_depth = jobs
        .iter()
        .filter(|job| {
            matches!(
                job.get("status").and_then(Value::as_str),
                Some("queued" | "checking")
            )
        })
        .count();

    json!({
        "isWatching": is_watching,
        "queueDepth": queue_depth,
        "activeEncodingJobId": active_encoding_job_id,
        "jobs": jobs,
        "logs": logs,
        "system": system,
        "appUpdate": app_update,
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn create_id(prefix: &str, sequence: usize) -> String {
    format!(
        "{prefix}-{}-{sequence}",
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
    )
}

fn merge_defaults(default_value: Value, saved_value: Value) -> Value {
    match (default_value, saved_value) {
        (Value::Object(mut default_map), Value::Object(saved_map)) => {
            for (key, saved_child) in saved_map {
                let next_value = match default_map.remove(&key) {
                    Some(default_child) => merge_defaults(default_child, saved_child),
                    None => saved_child,
                };
                default_map.insert(key, next_value);
            }
            Value::Object(default_map)
        }
        (_, saved) => saved,
    }
}

fn settings_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not resolve the app config directory.".to_string())?;

    Ok(config_dir
        .join(APP_CONFIG_DIR_NAME)
        .join(SETTINGS_FILE_NAME))
}

fn app_config_dir() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not resolve the app config directory.".to_string())?;
    Ok(config_dir.join(APP_CONFIG_DIR_NAME))
}

fn node_key_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(NODE_KEY_FILE_NAME))
}

fn desktop_node_key() -> Result<String, String> {
    let path = node_key_path()?;

    if path.exists() {
        let node_key = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?
            .trim()
            .to_string();
        if !node_key.is_empty() {
            return Ok(node_key);
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the node key parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let node_key = create_id("tauri-node", 1);
    fs::write(&path, &node_key)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(node_key)
}

#[cfg(test)]
fn test_keychain() -> &'static Mutex<HashMap<String, String>> {
    static TEST_KEYCHAIN: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
        std::sync::OnceLock::new();
    TEST_KEYCHAIN.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn secure_read_secret(account: &str) -> Result<Option<String>, String> {
    Ok(test_keychain()
        .lock()
        .map_err(|_| "Test keychain lock is unavailable.".to_string())?
        .get(account)
        .cloned())
}

#[cfg(not(test))]
fn secure_read_secret(account: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|error| format!("Could not open secure storage for {account}: {error}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read secure storage for {account}: {error}"
        )),
    }
}

#[cfg(test)]
fn secure_write_secret(account: &str, secret: &str) -> Result<(), String> {
    let mut keychain = test_keychain()
        .lock()
        .map_err(|_| "Test keychain lock is unavailable.".to_string())?;
    if secret.is_empty() {
        keychain.remove(account);
    } else {
        keychain.insert(account.to_string(), secret.to_string());
    }
    Ok(())
}

#[cfg(not(test))]
fn secure_write_secret(account: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|error| format!("Could not open secure storage for {account}: {error}"))?;
    if secret.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Could not clear secure storage for {account}: {error}"
            )),
        };
    }
    entry
        .set_password(secret)
        .map_err(|error| format!("Could not write secure storage for {account}: {error}"))
}

fn redact_secret_settings(mut settings: Value) -> Value {
    for (path, _) in SECRET_SETTING_PATHS {
        set_string_at_path(&mut settings, path, String::new());
    }
    settings
}

fn has_inline_settings_secrets(settings: &Value) -> bool {
    SECRET_SETTING_PATHS
        .iter()
        .any(|(path, _)| !string_setting(settings, path).trim().is_empty())
}

fn store_settings_secrets(settings: &Value) -> Result<(), String> {
    for (path, account) in SECRET_SETTING_PATHS {
        secure_write_secret(account, string_setting(settings, path).trim())?;
    }
    Ok(())
}

fn hydrate_settings_secrets(mut settings: Value) -> Result<Value, String> {
    for (path, account) in SECRET_SETTING_PATHS {
        if let Some(secret) = secure_read_secret(account)? {
            set_string_at_path(&mut settings, path, secret);
        }
    }
    Ok(settings)
}

fn write_settings_json(path: &Path, settings: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the settings parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    fs::write(&path, serialized)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn read_settings_file_without_secrets() -> Result<Value, String> {
    let path = settings_path()?;

    if !path.exists() {
        return Ok(default_settings());
    }

    let raw_settings = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let saved_settings = serde_json::from_str::<Value>(&raw_settings)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;

    Ok(normalize_settings_value(merge_defaults(
        default_settings(),
        saved_settings,
    )))
}

fn read_settings_file() -> Result<Value, String> {
    let path = settings_path()?;

    if !path.exists() {
        return Ok(default_settings());
    }

    let normalized_settings = read_settings_file_without_secrets()?;
    if has_inline_settings_secrets(&normalized_settings) {
        store_settings_secrets(&normalized_settings)?;
        write_settings_json(&path, &redact_secret_settings(normalized_settings.clone()))?;
    }

    hydrate_settings_secrets(normalized_settings)
}

fn write_settings_file(settings: &Value) -> Result<(), String> {
    let path = settings_path()?;
    let normalized_settings = normalize_settings_value(settings.clone());
    store_settings_secrets(&normalized_settings)?;
    write_settings_json(&path, &redact_secret_settings(normalized_settings))
}

fn connection_profile_name(profile: &Value) -> String {
    trim_string(profile.get("profileName"))
        .or_else(|| trim_string(profile.get("name")))
        .unwrap_or_else(|| "Imported Profile".to_string())
}

fn object_mut_at_path<'a>(
    value: &'a mut Value,
    path: &[&str],
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    let mut current = value;

    for segment in path {
        current = current
            .as_object_mut()
            .ok_or_else(|| "Settings must be a JSON object.".to_string())?
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }

    current
        .as_object_mut()
        .ok_or_else(|| "Settings section must be a JSON object.".to_string())
}

fn set_string_at_path(settings: &mut Value, path: &[&str], value: String) {
    let Some((key, parent_path)) = path.split_last() else {
        return;
    };

    if let Ok(parent_map) = object_mut_at_path(settings, parent_path) {
        parent_map.insert((*key).to_string(), Value::String(value));
    }
}

fn normalize_url_at_path(settings: &mut Value, path: &[&str]) {
    let current = string_setting(settings, path).to_string();
    set_string_at_path(settings, path, normalize_public_base_url(&current));
}

fn trim_string_at_path(settings: &mut Value, path: &[&str]) {
    let current = string_setting(settings, path).trim().to_string();
    set_string_at_path(settings, path, current);
}

fn normalize_settings_value(settings: Value) -> Value {
    let mut next_settings = merge_defaults(default_settings(), settings);

    normalize_url_at_path(&mut next_settings, &["r2", "publicBaseUrl"]);
    normalize_url_at_path(&mut next_settings, &["auth", "issuer"]);
    normalize_url_at_path(&mut next_settings, &["broker", "url"]);
    normalize_url_at_path(&mut next_settings, &["b2", "s3Endpoint"]);
    normalize_url_at_path(&mut next_settings, &["convex", "deploymentUrl"]);
    normalize_url_at_path(&mut next_settings, &["appUpdates", "baseUrl"]);

    for path in [
        &["watchFolder"][..],
        &["tempOutputPath"][..],
        &["b2", "bucket"][..],
        &["b2", "pathPrefix"][..],
        &["b2", "keyId"][..],
        &["b2", "applicationKey"][..],
        &["r2", "accountId"][..],
        &["r2", "bucket"][..],
        &["r2", "pathPrefix"][..],
        &["r2", "accessKeyId"][..],
        &["r2", "secretAccessKey"][..],
        &["convex", "mutationPath"][..],
        &["convex", "nodeToken"][..],
        &["auth", "issuer"][..],
        &["auth", "clientId"][..],
        &["broker", "url"][..],
        &["broker", "token"][..],
        &["offload", "localFolder"][..],
        &["offload", "b2PathPrefix"][..],
    ] {
        trim_string_at_path(&mut next_settings, path);
    }

    next_settings
}

fn set_profile_string(settings: &mut Value, profile: &Value, section: &str, key: &str) {
    let Some(value) = profile
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    if let Ok(section_map) = object_mut_at_path(settings, &[section]) {
        section_map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn set_profile_number(settings: &mut Value, profile: &Value, section: &str, key: &str) {
    let Some(value) = profile
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(Value::as_f64)
    else {
        return;
    };

    if let Ok(section_map) = object_mut_at_path(settings, &[section]) {
        section_map.insert(key.to_string(), Value::from(value));
    }
}

fn set_profile_bool(settings: &mut Value, profile: &Value, section: &str, key: &str) {
    let Some(value) = profile
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(Value::as_bool)
    else {
        return;
    };

    if let Ok(section_map) = object_mut_at_path(settings, &[section]) {
        section_map.insert(key.to_string(), Value::Bool(value));
    }
}

fn apply_connection_profile(settings: &Value, profile: &Value) -> Value {
    let mut next_settings = settings.clone();

    if let Some(layout) = profile
        .get("storage")
        .and_then(|storage| storage.get("layout"))
        .and_then(Value::as_str)
        .filter(|layout| matches!(*layout, "canonical" | "legacy"))
    {
        if let Ok(storage_map) = object_mut_at_path(&mut next_settings, &["storage"]) {
            storage_map.insert("layout".to_string(), Value::String(layout.to_string()));
        }
    }

    for key in ["bucket", "pathPrefix", "s3Endpoint"] {
        set_profile_string(&mut next_settings, profile, "b2", key);
    }
    for key in ["accountId", "bucket", "pathPrefix", "publicBaseUrl"] {
        set_profile_string(&mut next_settings, profile, "r2", key);
    }
    for key in ["deploymentUrl", "mutationPath"] {
        set_profile_string(&mut next_settings, profile, "convex", key);
    }
    set_profile_string(&mut next_settings, profile, "offload", "b2PathPrefix");
    set_profile_bool(&mut next_settings, profile, "appUpdates", "enabled");
    set_profile_string(&mut next_settings, profile, "appUpdates", "baseUrl");
    set_profile_number(
        &mut next_settings,
        profile,
        "appUpdates",
        "checkIntervalMinutes",
    );

    merge_defaults(default_settings(), next_settings)
}

fn build_connection_profile(settings: &Value, profile_name: &str) -> Value {
    json!({
        "profileVersion": 1,
        "profileName": profile_name,
        "storage": {
            "layout": string_setting(settings, &["storage", "layout"]),
        },
        "b2": {
            "bucket": string_setting(settings, &["b2", "bucket"]),
            "pathPrefix": string_setting(settings, &["b2", "pathPrefix"]),
            "s3Endpoint": string_setting(settings, &["b2", "s3Endpoint"]),
        },
        "r2": {
            "accountId": string_setting(settings, &["r2", "accountId"]),
            "bucket": string_setting(settings, &["r2", "bucket"]),
            "pathPrefix": string_setting(settings, &["r2", "pathPrefix"]),
            "publicBaseUrl": string_setting(settings, &["r2", "publicBaseUrl"]),
        },
        "convex": {
            "deploymentUrl": string_setting(settings, &["convex", "deploymentUrl"]),
            "mutationPath": string_setting(settings, &["convex", "mutationPath"]),
        },
        "offload": {
            "b2PathPrefix": string_setting(settings, &["offload", "b2PathPrefix"]),
        },
        "appUpdates": {
            "enabled": bool_setting(settings, &["appUpdates", "enabled"], false),
            "baseUrl": string_setting(settings, &["appUpdates", "baseUrl"]),
            "checkIntervalMinutes": number_setting(settings, &["appUpdates", "checkIntervalMinutes"], 60.0),
        },
        "exportedAt": now_iso(),
        "notes": "This profile intentionally excludes storage access keys and the media library node token.",
    })
}

fn string_setting<'a>(settings: &'a Value, path: &[&str]) -> &'a str {
    let mut current = settings;

    for segment in path {
        current = match current.get(*segment) {
            Some(value) => value,
            None => return "",
        };
    }

    current.as_str().unwrap_or("")
}

fn compact_url(value: &str) -> String {
    value.split_whitespace().collect::<String>()
}

fn normalize_public_base_url(value: &str) -> String {
    let compacted = compact_url(value).trim_end_matches('/').to_string();

    if compacted.is_empty()
        || compacted.starts_with("http://")
        || compacted.starts_with("https://")
        || compacted.starts_with("file://")
    {
        compacted
    } else {
        format!("https://{compacted}")
    }
}

fn normalized_url_setting(settings: &Value, path: &[&str]) -> String {
    normalize_public_base_url(string_setting(settings, path))
}

fn configured_tool_path(binary: &str) -> Option<PathBuf> {
    let env_key = match binary {
        "ffmpeg" => "CSN_FFMPEG_PATH",
        "ffprobe" => "CSN_FFPROBE_PATH",
        "rclone" => "CSN_RCLONE_PATH",
        _ => return None,
    };

    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn tool_candidates(binary: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(configured_path) = configured_tool_path(binary) {
        candidates.push(configured_path);
    }

    candidates.push(PathBuf::from(binary));

    for directory in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/local/bin",
    ] {
        candidates.push(PathBuf::from(directory).join(binary));
    }

    candidates
}

fn resolve_tool(binary: &str, args: &[&str]) -> PathBuf {
    for candidate in tool_candidates(binary) {
        let output = Command::new(&candidate).args(args).output();

        if output
            .map(|output| {
                output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty()
            })
            .unwrap_or(false)
        {
            return candidate;
        }
    }

    PathBuf::from(binary)
}

fn resolved_tool_display(binary: &str, args: &[&str]) -> Option<String> {
    let resolved = resolve_tool(binary, args);
    let output = Command::new(&resolved).args(args).output();

    output
        .map(|output| {
            output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty()
        })
        .unwrap_or(false)
        .then(|| resolved.to_string_lossy().to_string())
}

fn path_exists(path: &str) -> bool {
    !path.trim().is_empty() && PathBuf::from(path).exists()
}

fn system_time_to_iso(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn trim_string(value: Option<&Value>) -> Option<String> {
    let next_value = value?.as_str()?.trim().to_string();

    if next_value.is_empty() {
        None
    } else {
        Some(next_value)
    }
}

fn string_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| Value::String(item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn number_setting(settings: &Value, path: &[&str], fallback: f64) -> f64 {
    let mut current = settings;

    for segment in path {
        current = match current.get(*segment) {
            Some(value) => value,
            None => return fallback,
        };
    }

    current.as_f64().unwrap_or(fallback)
}

fn bool_setting(settings: &Value, path: &[&str], fallback: bool) -> bool {
    let mut current = settings;

    for segment in path {
        current = match current.get(*segment) {
            Some(value) => value,
            None => return fallback,
        };
    }

    current.as_bool().unwrap_or(fallback)
}

fn value_to_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn pick_path_to_string(path: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    path.into_path()
        .map_err(|error| format!("Could not resolve selected path: {error}"))
        .map(|path| path.to_string_lossy().to_string())
}

fn inspect_manual_file(path: PathBuf, include_source_url: bool) -> Result<Value, String> {
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;

    if !metadata.is_file() {
        return Err("Choose a file, not a folder.".to_string());
    }

    let source_path = path.to_string_lossy().to_string();
    let modified_at = metadata
        .modified()
        .map(system_time_to_iso)
        .unwrap_or_else(|_| now_iso());
    let duration_seconds = probe_source(&path)
        .ok()
        .and_then(|probe| probe.get("durationSeconds").cloned())
        .unwrap_or(Value::Null);

    if include_source_url {
        Ok(json!({
            "sourcePath": source_path,
            "sourceFileName": file_name(&path),
            "sourceUrl": format!("file://{source_path}"),
            "fileSizeBytes": metadata.len(),
            "durationSeconds": duration_seconds,
            "modifiedAt": modified_at,
        }))
    } else {
        Ok(json!({
            "sourcePath": source_path,
            "sourceFileName": file_name(&path),
            "fileSizeBytes": metadata.len(),
            "durationSeconds": duration_seconds,
            "modifiedAt": modified_at,
        }))
    }
}

fn parse_frame_rate(rate: Option<&str>) -> Option<f64> {
    let rate = rate?;
    if rate.trim().is_empty() || rate == "0/0" {
        return None;
    }

    let mut parts = rate.split('/');
    let numerator = parts.next()?.parse::<f64>().ok()?;
    let denominator = parts.next().unwrap_or("1").parse::<f64>().ok()?;

    if denominator == 0.0 {
        return None;
    }

    Some((numerator / denominator * 1000.0).round() / 1000.0)
}

fn codec_name(stream: Option<&Value>) -> Option<String> {
    let stream = stream?;
    trim_string(stream.get("codec_name")).or_else(|| trim_string(stream.get("codec_long_name")))
}

fn probe_source(path: &Path) -> Result<Value, String> {
    let ffprobe_path = resolve_tool("ffprobe", &["-version"]);
    let output = Command::new(&ffprobe_path)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|error| {
            format!(
                "Could not start ffprobe at {}: {error}",
                ffprobe_path.display()
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "FFprobe could not inspect the selected source.".to_string()
        } else {
            stderr
        });
    }

    let metadata = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| format!("Could not parse ffprobe output: {error}"))?;
    let streams = metadata
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let video_stream = streams.iter().find(|stream| {
        stream
            .get("codec_type")
            .and_then(Value::as_str)
            .is_some_and(|codec_type| codec_type == "video")
    });
    let audio_stream = streams.iter().find(|stream| {
        stream
            .get("codec_type")
            .and_then(Value::as_str)
            .is_some_and(|codec_type| codec_type == "audio")
    });
    let duration_seconds = metadata
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(Value::as_str)
        .and_then(|duration| duration.parse::<f64>().ok());
    let frame_rate = parse_frame_rate(
        video_stream
            .and_then(|stream| stream.get("avg_frame_rate"))
            .and_then(Value::as_str)
            .or_else(|| {
                video_stream
                    .and_then(|stream| stream.get("r_frame_rate"))
                    .and_then(Value::as_str)
            }),
    );

    Ok(json!({
        "durationSeconds": duration_seconds,
        "hasAudio": audio_stream.is_some(),
        "frameRate": frame_rate,
        "width": video_stream
            .and_then(|stream| stream.get("width"))
            .and_then(Value::as_u64),
        "height": video_stream
            .and_then(|stream| stream.get("height"))
            .and_then(Value::as_u64),
        "videoCodec": codec_name(video_stream),
        "audioCodec": codec_name(audio_stream),
    }))
}

fn manual_pipeline_preset(
    route: &str,
) -> Result<
    (
        &'static str,
        Option<&'static str>,
        &'static str,
        &'static str,
    ),
    String,
> {
    match route {
        "web_streaming" => Ok(("auto", None, "approved", "none")),
        "clip_progressive" => Ok(("progressive", Some("clip"), "approved", "none")),
        "review_draft" => Ok(("auto", Some("vod"), "needs_review", "none")),
        _ => Err("Choose a valid manual intake pipeline.".to_string()),
    }
}

fn get_hls_keyframe_interval(frame_rate: Option<f64>) -> u64 {
    let normalized_frame_rate = frame_rate.filter(|rate| *rate > 0.0).unwrap_or(30.0);
    (normalized_frame_rate * HLS_SEGMENT_DURATION_SECONDS as f64)
        .round()
        .max(24.0) as u64
}

fn build_hls_scale_filter() -> String {
    let split_outputs = HLS_VARIANTS
        .iter()
        .map(|variant| format!("[v{}src]", variant.label))
        .collect::<String>();
    let scale_filters = HLS_VARIANTS
        .iter()
        .map(|variant| {
            format!(
                "[v{}src]scale=w={}:h={}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black[v{}]",
                variant.label,
                variant.width,
                variant.height,
                variant.width,
                variant.height,
                variant.label
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    format!(
        "[0:v]split={}{};{}",
        HLS_VARIANTS.len(),
        split_outputs,
        scale_filters
    )
}

fn output_root(settings: &Value) -> Result<PathBuf, String> {
    let configured_path = string_setting(settings, &["tempOutputPath"]);

    if !configured_path.trim().is_empty() {
        return Ok(PathBuf::from(configured_path));
    }

    let cache_dir = dirs::cache_dir()
        .ok_or_else(|| "Could not resolve the app cache directory.".to_string())?;
    Ok(cache_dir.join(APP_CONFIG_DIR_NAME).join("outputs"))
}

fn file_url(path: &Path) -> String {
    format!("file://{}", path.to_string_lossy())
}

fn join_object_key(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .filter_map(|part| part.as_ref())
        .map(|part| part.trim_matches('/').trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn join_public_url(base_url: &str, object_key: &str) -> String {
    let normalized_base = normalize_public_base_url(base_url);

    if object_key.trim().is_empty() {
        normalized_base
    } else {
        format!("{normalized_base}/{}", object_key.trim_matches('/'))
    }
}

fn media_proxy_url(origin: &str, remote_url: &str) -> Option<String> {
    let parsed_url = reqwest::Url::parse(remote_url).ok()?;
    let scheme = parsed_url.scheme();

    if scheme != "http" && scheme != "https" {
        return None;
    }

    let host = parsed_url.host_str()?;
    let host_with_port = match parsed_url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let query = parsed_url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();

    Some(format!(
        "{origin}/{scheme}/{host_with_port}{}{}",
        parsed_url.path(),
        query
    ))
}

fn proxy_url_value(settings: &Value, origin: &str, value: Option<&Value>) -> Option<Value> {
    let remote_url = value?.as_str()?;
    // Through the broker first when it is serving media, then through the local
    // proxy so the webview plays from loopback either way.
    let remote_url =
        broker_media_url(settings, remote_url).unwrap_or_else(|| remote_url.to_string());

    media_proxy_url(origin, &remote_url)
        .or(Some(remote_url))
        .map(Value::String)
}

/// Where a video's storyboard sits, by convention rather than by a stored
/// field: it is written into the playback package, so its address follows from
/// the package's own. Deriving it keeps the library schema — which the CSN web
/// app shares — unchanged.
fn stored_thumbnails_url(settings: &Value, video: &Value) -> Option<String> {
    let distribution_object_key = video_str(video, "distributionObjectKey")?;
    // Only a finished video has a package to hold one.
    if video_str(video, "playbackUrl").is_none() && video_str(video, "manifestUrl").is_none() {
        return None;
    }

    Some(public_url_for(
        settings,
        distribution_object_key,
        Some(&format!("{THUMBNAIL_DIRECTORY}/{THUMBNAIL_VTT_FILENAME}")),
    ))
}

fn proxy_stored_video_urls(video: Value, settings: &Value, origin: &str) -> Value {
    let Some(mut map) = video.as_object().cloned() else {
        return video;
    };

    // Derived before the rewrite below, so it travels the same path as every
    // other media URL — through the broker when that is on, then the proxy.
    if let Some(thumbnails_url) = stored_thumbnails_url(settings, &Value::Object(map.clone())) {
        map.insert("thumbnailsUrl".to_string(), Value::String(thumbnails_url));
    }

    for key in [
        "masterPlaylistUrl",
        "manifestUrl",
        "dashManifestUrl",
        "playbackUrl",
        "posterUrl",
        "thumbnailsUrl",
    ] {
        if let Some(next_value) = proxy_url_value(settings, origin, map.get(key)) {
            map.insert(key.to_string(), next_value);
        }
    }

    if let Some(sources) = map.get("sources").and_then(Value::as_array) {
        let next_sources = sources
            .iter()
            .map(|source| {
                let Some(mut source_map) = source.as_object().cloned() else {
                    return source.clone();
                };

                if let Some(next_value) = proxy_url_value(settings, origin, source_map.get("url")) {
                    source_map.insert("url".to_string(), next_value);
                }

                Value::Object(source_map)
            })
            .collect::<Vec<_>>();
        map.insert("sources".to_string(), Value::Array(next_sources));
    }

    Value::Object(map)
}

fn media_proxy_target(request_target: &str) -> Option<String> {
    let path_with_query = request_target.split('#').next().unwrap_or(request_target);
    let mut path_and_query = path_with_query.splitn(2, '?');
    let path = path_and_query.next()?.trim_start_matches('/');
    let query = path_and_query.next();
    let mut segments = path.splitn(3, '/');
    let scheme = segments.next()?;
    let host = segments.next()?;
    let remainder = segments.next().unwrap_or("");

    if (scheme != "http" && scheme != "https") || host.is_empty() {
        return None;
    }

    let mut target = format!("{scheme}://{host}/{remainder}");
    if let Some(query) = query {
        target.push('?');
        target.push_str(query);
    }

    Some(target)
}

fn write_proxy_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n"
    )?;

    for (name, value) in headers {
        if !value.contains('\r') && !value.contains('\n') {
            write!(stream, "{name}: {value}\r\n")?;
        }
    }

    write!(stream, "\r\n")
}

fn write_proxy_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    write_proxy_headers(stream, status, reason, headers)?;
    stream.write_all(body)?;
    stream.flush()
}

fn handle_media_proxy_request(mut stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("Could not clone proxy stream: {error}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| format!("Could not read proxy request: {error}"))?;
    let parts = request_line.split_whitespace().collect::<Vec<_>>();

    if parts.len() < 2 {
        write_proxy_response(
            &mut stream,
            400,
            "Bad Request",
            &[("Content-Type", "text/plain; charset=utf-8".to_string())],
            b"Invalid proxy request.",
        )
        .ok();
        return Ok(());
    }

    let method = parts[0];
    let request_target = parts[1];
    let mut accept_header: Option<String> = None;
    let mut range_header: Option<String> = None;

    loop {
        let mut header_line = String::new();
        reader
            .read_line(&mut header_line)
            .map_err(|error| format!("Could not read proxy headers: {error}"))?;

        if header_line == "\r\n" || header_line == "\n" || header_line.is_empty() {
            break;
        }

        if let Some((name, value)) = header_line.split_once(':') {
            let normalized_name = name.trim().to_ascii_lowercase();
            let normalized_value = value.trim().to_string();

            if normalized_name == "accept" {
                accept_header = Some(normalized_value);
            } else if normalized_name == "range" {
                range_header = Some(normalized_value);
            }
        }
    }

    if method == "OPTIONS" {
        write_proxy_response(&mut stream, 204, "No Content", &[], &[]).ok();
        return Ok(());
    }

    if method != "GET" && method != "HEAD" {
        write_proxy_response(
            &mut stream,
            405,
            "Method Not Allowed",
            &[("Content-Type", "text/plain; charset=utf-8".to_string())],
            b"Method not allowed.",
        )
        .ok();
        return Ok(());
    }

    let Some(target_url) = media_proxy_target(request_target) else {
        write_proxy_response(
            &mut stream,
            400,
            "Bad Request",
            &[("Content-Type", "text/plain; charset=utf-8".to_string())],
            b"Invalid proxy target.",
        )
        .ok();
        return Ok(());
    };

    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("Could not start media proxy runtime: {error}"))?;
    let response = runtime.block_on(async {
        let client = reqwest::Client::new();
        let request_method = if method == "HEAD" {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        };
        let mut request = client.request(request_method, target_url.clone());

        // Playback served by the broker is authenticated. Both credentials stay
        // in the host: the webview only ever sees a loopback URL, so a page bug
        // cannot read either.
        if let Some(credentials) = broker_media_credentials(&target_url) {
            request = request.bearer_auth(credentials.0);
            // The library decides whether this station's organization owns the
            // asset, and it identifies the station by its node token.
            if let Some(node_token) = credentials.1 {
                request = request.header("X-CSN-Node-Token", node_token);
            }
        }

        if let Some(accept_header) = accept_header {
            request = request.header("accept", accept_header);
        }
        if let Some(range_header) = range_header {
            request = request.header("range", range_header);
        }

        request.send().await
    });
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            write_proxy_response(
                &mut stream,
                502,
                "Bad Gateway",
                &[("Content-Type", "text/plain; charset=utf-8".to_string())],
                error.to_string().as_bytes(),
            )
            .ok();
            return Ok(());
        }
    };
    let status = response.status();
    let mut headers = Vec::new();

    for header_name in [
        "accept-ranges",
        "cache-control",
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "last-modified",
    ] {
        if let Some(value) = response
            .headers()
            .get(header_name)
            .and_then(|value| value.to_str().ok())
        {
            headers.push((header_name, value.to_string()));
        }
    }

    if method == "HEAD" {
        write_proxy_response(
            &mut stream,
            status.as_u16(),
            status.canonical_reason().unwrap_or("OK"),
            &headers,
            &[],
        )
        .ok();
        return Ok(());
    }

    // Streamed rather than collected. Buffering a whole response before sending
    // a byte adds its download time to the start of every segment, and for a
    // progressive MP4 it would hold the requested range in memory for no
    // reason. The player gets the first bytes as soon as they arrive.
    write_proxy_headers(
        &mut stream,
        status.as_u16(),
        status.canonical_reason().unwrap_or("OK"),
        &headers,
    )
    .map_err(|error| format!("Could not write media proxy response: {error}"))?;

    let mut response = response;
    loop {
        let chunk = runtime
            .block_on(response.chunk())
            .map_err(|error| format!("Could not read upstream media response: {error}"))?;

        let Some(chunk) = chunk else {
            break;
        };

        // A player that seeks or closes mid-segment drops the connection, and
        // that is ordinary rather than an error worth reporting.
        if stream.write_all(&chunk).is_err() {
            return Ok(());
        }
    }

    stream
        .flush()
        .map_err(|error| format!("Could not write media proxy response: {error}"))
}

fn ensure_media_proxy_origin(state: &tauri::State<'_, AppState>) -> Result<String, String> {
    {
        let existing_origin = state
            .media_proxy_origin
            .lock()
            .map_err(|_| "Media proxy lock is unavailable.".to_string())?
            .clone();

        if let Some(existing_origin) = existing_origin {
            return Ok(existing_origin);
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not start media proxy: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read media proxy address: {error}"))?;
    let origin = format!("http://127.0.0.1:{}", address.port());

    {
        let mut stored_origin = state
            .media_proxy_origin
            .lock()
            .map_err(|_| "Media proxy lock is unavailable.".to_string())?;
        *stored_origin = Some(origin.clone());
    }

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let _ = handle_media_proxy_request(stream);
            });
        }
    });

    Ok(origin)
}

fn slugify_segment(value: Option<&str>, fallback: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in value
        .unwrap_or_default()
        .chars()
        .flat_map(char::to_lowercase)
    {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }

        if slug.len() >= 64 {
            break;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

fn sanitize_file_name(file_name: &str, fallback: &str) -> String {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let safe = base
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_start_matches('.')
        .to_string();

    if safe.is_empty() {
        fallback.to_string()
    } else {
        safe
    }
}

fn date_segment(value: Option<&str>) -> String {
    let candidate = value.unwrap_or_default();
    if candidate.len() >= 10 {
        let prefix = &candidate[..10];
        if prefix.chars().enumerate().all(|(index, character)| {
            matches!(index, 4 | 7) && character == '-'
                || !matches!(index, 4 | 7) && character.is_ascii_digit()
        }) {
            return prefix.to_string();
        }
    }

    now_iso()[..10].to_string()
}

fn compute_source_fingerprint(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "Could not open {} for fingerprinting: {error}",
            path.display()
        )
    })?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|error| {
            format!(
                "Could not read {} for fingerprinting: {error}",
                path.display()
            )
        })?;

        if bytes_read == 0 {
            break;
        }

        hash.update(&buffer[..bytes_read]);
    }

    Ok(format!("sha256:{:x}", hash.finalize()))
}

fn derive_asset_key(source_fingerprint: &str, fallback_seed: &str) -> String {
    let hex = source_fingerprint
        .strip_prefix("sha256:")
        .unwrap_or(source_fingerprint)
        .trim()
        .to_ascii_lowercase();

    if hex.len() >= 16 && hex.chars().all(|character| character.is_ascii_hexdigit()) {
        hex[..16].to_string()
    } else {
        slugify_segment(Some(fallback_seed), "asset")
    }
}

fn build_storage_key_plan(settings: &Value, job: &Value, source_fingerprint: &str) -> Value {
    let source_name = job
        .get("sourceName")
        .and_then(Value::as_str)
        .unwrap_or("source.bin");
    let job_id = job.get("id").and_then(Value::as_str).unwrap_or("job");
    let source_path = job
        .get("sourcePath")
        .and_then(Value::as_str)
        .unwrap_or(source_name);
    let job_folder_name = format!(
        "{}-{}",
        slugify_segment(
            Path::new(source_path)
                .file_stem()
                .and_then(|name| name.to_str()),
            "vod"
        ),
        &job_id.chars().take(8).collect::<String>()
    );
    let layout = string_setting(settings, &["storage", "layout"]);
    let project_name = job.get("projectName").and_then(Value::as_str);
    let recorded_at = job.get("recordedAt").and_then(Value::as_str);
    let asset_key = derive_asset_key(source_fingerprint, &job_folder_name);

    if layout == "legacy" {
        return json!({
            "layout": "legacy",
            "assetKey": asset_key,
            "archiveObjectKey": join_object_key(&[
                Some(string_setting(settings, &["b2", "pathPrefix"]).to_string()),
                Some(job_folder_name.clone()),
                Some(source_name.to_string()),
            ]),
            "distributionObjectKey": join_object_key(&[
                Some(string_setting(settings, &["r2", "pathPrefix"]).to_string()),
                Some(job_folder_name),
            ]),
            "posterObjectKey": null,
        });
    }

    json!({
        "layout": "canonical",
        "assetKey": asset_key,
        "archiveObjectKey": join_object_key(&[
            Some(MASTERS_PREFIX.to_string()),
            Some(slugify_segment(project_name, UNASSIGNED_PROJECT_SEGMENT)),
            Some(date_segment(recorded_at)),
            Some(asset_key.clone()),
            Some(sanitize_file_name(source_name, &format!("{asset_key}.bin"))),
        ]),
        "distributionObjectKey": join_object_key(&[
            Some(STREAMING_PREFIX.to_string()),
            Some(asset_key.clone()),
        ]),
        "posterObjectKey": join_object_key(&[
            Some(POSTERS_PREFIX.to_string()),
            Some(asset_key),
            Some("default.jpg".to_string()),
        ]),
    })
}

fn parse_bitrate(value: &str) -> u64 {
    value
        .strip_suffix('k')
        .or_else(|| value.strip_suffix('K'))
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| (value * 1000.0).round() as u64)
        .or_else(|| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn format_iso_duration(seconds: f64) -> String {
    let safe_seconds = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    };
    let formatted = format!("{safe_seconds:.3}");
    format!(
        "PT{}S",
        formatted.trim_end_matches('0').trim_end_matches('.')
    )
}

fn escape_xml_attribute(value: impl ToString) -> String {
    value
        .to_string()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn parse_hls_segment_durations(playlist: &str) -> Vec<u64> {
    playlist
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
        .filter_map(|line| line.split(',').next())
        .filter_map(|duration| duration.parse::<f64>().ok())
        .map(|duration| (duration * 1000.0).round().max(1.0) as u64)
        .collect()
}

fn fallback_segment_durations(duration_seconds: f64) -> Vec<u64> {
    let total_ms =
        (duration_seconds.max(HLS_SEGMENT_DURATION_SECONDS as f64) * 1000.0).round() as u64;
    let segment_ms = HLS_SEGMENT_DURATION_SECONDS * 1000;
    let mut durations = Vec::new();
    let mut remaining_ms = total_ms.max(1);

    while remaining_ms > 0 {
        let duration_ms = remaining_ms.min(segment_ms);
        durations.push(duration_ms);
        remaining_ms -= duration_ms;
    }

    durations
}

fn build_segment_timeline_xml(segment_durations_ms: &[u64]) -> String {
    let mut entries = Vec::new();
    let mut index = 0;

    while index < segment_durations_ms.len() {
        let duration_ms = segment_durations_ms[index];
        let mut repeat = 0;

        while segment_durations_ms.get(index + repeat + 1) == Some(&duration_ms) {
            repeat += 1;
        }

        entries.push(format!(
            "        <S d=\"{}\"{}/>",
            escape_xml_attribute(duration_ms),
            if repeat > 0 {
                format!(" r=\"{}\"", escape_xml_attribute(repeat))
            } else {
                String::new()
            }
        ));
        index += repeat + 1;
    }

    entries.join("\n")
}

fn write_dash_manifest(
    output_directory: &Path,
    duration_seconds: f64,
    has_audio: bool,
) -> Result<PathBuf, String> {
    let reference_variant = HLS_VARIANTS
        .first()
        .ok_or_else(|| "No HLS variants are configured.".to_string())?;
    let reference_playlist_path = output_directory
        .join("video")
        .join(reference_variant.rendition_name())
        .join("stream.m3u8");
    let reference_playlist = fs::read_to_string(&reference_playlist_path).unwrap_or_default();
    let parsed_durations = parse_hls_segment_durations(&reference_playlist);
    let segment_durations = if parsed_durations.is_empty() {
        fallback_segment_durations(duration_seconds)
    } else {
        parsed_durations
    };
    let timeline_duration_seconds = segment_durations.iter().sum::<u64>() as f64 / 1000.0;
    let manifest_duration = if duration_seconds > 0.0 {
        duration_seconds
    } else {
        timeline_duration_seconds
    };
    let codecs = if has_audio {
        "avc1.640028,mp4a.40.2"
    } else {
        "avc1.640028"
    };
    let representations = HLS_VARIANTS
        .iter()
        .enumerate()
        .map(|(_, variant)| {
            format!(
                "      <Representation id=\"{}\" bandwidth=\"{}\" width=\"{}\" height=\"{}\" codecs=\"{}\"/>",
                escape_xml_attribute(variant.rendition_name()),
                escape_xml_attribute(parse_bitrate(variant.bitrate)),
                escape_xml_attribute(variant.width),
                escape_xml_attribute(variant.height),
                escape_xml_attribute(codecs)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let manifest = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     profiles="urn:mpeg:dash:profile:isoff-main:2011"
     type="static"
     mediaPresentationDuration="{}"
     minBufferTime="{}"
     maxSegmentDuration="{}">
  <Period id="0" duration="{}">
    <AdaptationSet id="0"
                   mimeType="video/mp4"
                   segmentAlignment="true"
                   subsegmentAlignment="true"
                   startWithSAP="1">
      <SegmentTemplate timescale="1000"
                       startNumber="1"
                       initialization="video/$RepresentationID$/init.mp4"
                       media="video/$RepresentationID$/chunk_$Number%05d$.m4s">
        <SegmentTimeline>
{}
        </SegmentTimeline>
      </SegmentTemplate>
{}
    </AdaptationSet>
  </Period>
</MPD>
"#,
        escape_xml_attribute(format_iso_duration(manifest_duration)),
        escape_xml_attribute(format_iso_duration(
            HLS_SEGMENT_DURATION_SECONDS as f64 * 2.0
        )),
        escape_xml_attribute(format_iso_duration(HLS_SEGMENT_DURATION_SECONDS as f64)),
        escape_xml_attribute(format_iso_duration(manifest_duration)),
        build_segment_timeline_xml(&segment_durations),
        representations
    );
    let output_path = output_directory.join(DASH_MANIFEST_FILENAME);
    fs::write(&output_path, manifest)
        .map_err(|error| format!("Could not write {}: {error}", output_path.display()))?;

    Ok(output_path)
}

fn run_ffmpeg(args: &[String]) -> Result<(), String> {
    let ffmpeg_path = resolve_tool("ffmpeg", &["-version"]);
    let output = Command::new(&ffmpeg_path)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Could not start ffmpeg at {}: {error}",
                ffmpeg_path.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail = stderr
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    Err(if tail.trim().is_empty() {
        "FFmpeg exited without a diagnostic message.".to_string()
    } else {
        tail
    })
}

fn storage_is_configured(settings: &Value) -> bool {
    !string_setting(settings, &["b2", "bucket"])
        .trim()
        .is_empty()
        && !string_setting(settings, &["b2", "keyId"]).trim().is_empty()
        && !string_setting(settings, &["b2", "applicationKey"])
            .trim()
            .is_empty()
        && !string_setting(settings, &["r2", "bucket"])
            .trim()
            .is_empty()
        && !string_setting(settings, &["r2", "accountId"])
            .trim()
            .is_empty()
        && !string_setting(settings, &["r2", "accessKeyId"])
            .trim()
            .is_empty()
        && !string_setting(settings, &["r2", "secretAccessKey"])
            .trim()
            .is_empty()
        && !string_setting(settings, &["r2", "publicBaseUrl"])
            .trim()
            .is_empty()
}

/* ---------------------------------------------------------- brokered credentials */

/// Storage credentials that expire.
///
/// A station has to hand real credentials to rclone — there is no way around
/// that — but it does not have to hold the *master* keys to do it. When a
/// broker is configured, the station asks it for credentials scoped to one
/// bucket, one prefix and one set of operations, valid for hours rather than
/// forever, and uses those instead.
///
/// The cache is a process global rather than a field on `AppState` because
/// `rclone_config` is called from eight places, several of them deep inside
/// synchronous transfer code, and threading a parameter through all of them to
/// carry derived data would obscure more than it explains. There is exactly one
/// writer — the refresh loop below.
static BROKERED_CREDENTIALS: std::sync::OnceLock<Mutex<Option<Value>>> = std::sync::OnceLock::new();

fn brokered_credentials_cell() -> &'static Mutex<Option<Value>> {
    BROKERED_CREDENTIALS.get_or_init(|| Mutex::new(None))
}

/// The cached credentials, if they have not expired. Expiry is checked on read
/// so a stale set is never handed to rclone after a long idle period.
fn current_brokered_credentials() -> Option<Value> {
    let guard = brokered_credentials_cell().lock().ok()?;
    let credentials = guard.clone()?;
    let expires_at = trim_string(credentials.get("expiresAt"))?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&expires_at).ok()?;

    (expires_at > chrono::Utc::now()).then_some(credentials)
}

fn store_brokered_credentials(credentials: Option<Value>) {
    if let Ok(mut cell) = brokered_credentials_cell().lock() {
        *cell = credentials;
    }
}

/// Whether playback should be streamed through the broker instead of straight
/// from the public bucket. Off by default: turning it on before the Worker is
/// deployed would stop every video playing.
fn broker_streams_media(settings: &Value) -> bool {
    broker_is_configured(settings) && bool_setting(settings, &["broker", "streamMedia"], false)
}

/// Rewrites a public bucket URL to go through the broker.
///
/// HLS manifests reference their segments relatively, so rewriting the manifest
/// URL is enough — the player resolves every segment against the broker too.
fn broker_media_url(settings: &Value, url: &str) -> Option<String> {
    if !broker_streams_media(settings) {
        return None;
    }

    let public_base = normalize_public_base_url(string_setting(settings, &["r2", "publicBaseUrl"]));
    if public_base.is_empty() {
        return None;
    }

    let object_key = url.strip_prefix(&public_base)?.trim_start_matches('/');
    if object_key.is_empty() {
        return None;
    }

    Some(format!("{}/media/{object_key}", broker_url(settings)))
}

/// The station token, and the library credential the broker needs to ask who
/// owns an asset — but only when the proxy is about to fetch from the broker's
/// own media route. Credentials must never be attached to an arbitrary URL.
fn broker_media_credentials(target_url: &str) -> Option<(String, Option<String>)> {
    let settings = read_settings_file().ok()?;
    if !broker_streams_media(&settings) {
        return None;
    }

    let media_prefix = format!("{}/media/", broker_url(&settings));
    if !target_url.starts_with(&media_prefix) {
        return None;
    }

    let station_token = string_setting(&settings, &["broker", "token"])
        .trim()
        .to_string();
    if station_token.is_empty() {
        return None;
    }

    let node_token = string_setting(&settings, &["convex", "nodeToken"])
        .trim()
        .to_string();

    Some((
        station_token,
        (!node_token.is_empty()).then_some(node_token),
    ))
}

fn broker_url(settings: &Value) -> String {
    string_setting(settings, &["broker", "url"])
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn broker_is_configured(settings: &Value) -> bool {
    !broker_url(settings).is_empty()
        && !string_setting(settings, &["broker", "token"])
            .trim()
            .is_empty()
}

/// Asks the broker for a fresh, scoped set.
async fn fetch_brokered_credentials(settings: &Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/credentials", broker_url(settings)))
        .bearer_auth(string_setting(settings, &["broker", "token"]).trim())
        .json(&json!({
            "purpose": "ingest",
            // Only what this station actually writes. The broker refuses
            // anything outside its own allowlist regardless.
            "r2Prefixes": [
                format!("{STREAMING_PREFIX}/"),
                format!("{POSTERS_PREFIX}/"),
            ],
            "b2NamePrefix": format!("{MASTERS_PREFIX}/"),
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach the credential broker: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read the broker's answer: {error}"))?;

    if !status.is_success() {
        return Err(format!("The credential broker refused ({status}): {text}"));
    }

    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse the broker's answer: {error}"))
}

/// Keeps the cache warm.
///
/// Refreshing well before expiry rather than on demand means a transfer never
/// waits on the broker, and a broker that is briefly down costs nothing until
/// the current credentials actually run out — at which point the station falls
/// back to whatever is configured locally rather than stopping.
fn credential_refresh_loop(app: tauri::AppHandle) {
    loop {
        let settings = {
            let state = app.state::<AppState>();
            settings_snapshot_from_state(&state).unwrap_or_else(|_| default_settings())
        };

        if broker_is_configured(&settings) {
            match tauri::async_runtime::block_on(fetch_brokered_credentials(&settings)) {
                Ok(credentials) => {
                    let expires = trim_string(credentials.get("expiresAt")).unwrap_or_default();
                    store_brokered_credentials(Some(credentials));
                    let state = app.state::<AppState>();
                    let _ = append_log(
                        &state,
                        "info",
                        "sync",
                        format!("Picked up short-lived storage credentials, good until {expires}."),
                        None,
                    );
                }
                Err(error) => {
                    // Leave whatever is cached in place: it may still be valid,
                    // and if it is not, transfers fall back to the local keys.
                    let state = app.state::<AppState>();
                    let _ = append_log(&state, "warn", "sync", error, None);
                }
            }
            emit_state_update(&app);
        }

        // Comfortably inside the broker's default lifetime, so a long upload
        // never straddles an expiry.
        thread::sleep(Duration::from_secs(2 * 60 * 60));
    }
}

fn rclone_config(settings: &Value) -> String {
    // Short-lived brokered credentials win when they are available; the keys in
    // Settings are the fallback, so a station whose broker is unreachable keeps
    // working rather than stopping.
    let brokered = current_brokered_credentials();
    let brokered_field = |section: &str, field: &str| -> Option<String> {
        trim_string(brokered.as_ref()?.get(section)?.get(field))
    };

    let b2_account = brokered_field("b2", "keyId")
        .unwrap_or_else(|| string_setting(settings, &["b2", "keyId"]).to_string());
    let b2_key = brokered_field("b2", "applicationKey")
        .unwrap_or_else(|| string_setting(settings, &["b2", "applicationKey"]).to_string());
    let r2_access_key_id = brokered_field("r2", "accessKeyId")
        .unwrap_or_else(|| string_setting(settings, &["r2", "accessKeyId"]).to_string());
    let r2_secret = brokered_field("r2", "secretAccessKey")
        .unwrap_or_else(|| string_setting(settings, &["r2", "secretAccessKey"]).to_string());

    // Before its first upload into a bucket, rclone checks the bucket exists and
    // creates it when the check fails. Neither the brokered credentials nor a
    // sensibly scoped API key can do either: they are granted objects under a
    // prefix, not the bucket itself. So the existence check comes back refused,
    // rclone tries to create a bucket that has been there all along, and the
    // upload dies on a 403 that reads like a credential problem and is not one.
    //
    // The buckets are created by an operator during setup and named in
    // Settings. Nothing here should ever make one.
    let mut lines = vec![
        "[csnb2]".to_string(),
        "type = b2".to_string(),
        format!("account = {b2_account}"),
        format!("key = {b2_key}"),
        "no_check_bucket = true".to_string(),
        String::new(),
        "[csnr2]".to_string(),
        "type = s3".to_string(),
        "provider = Cloudflare".to_string(),
        format!("access_key_id = {r2_access_key_id}"),
        format!("secret_access_key = {r2_secret}"),
    ];

    // Temporary R2 credentials are SigV4 session credentials, so they only work
    // when the session token travels with them.
    if let Some(session_token) = brokered_field("r2", "sessionToken") {
        lines.push(format!("session_token = {session_token}"));
    }

    lines.extend([
        format!(
            "endpoint = https://{}.r2.cloudflarestorage.com",
            string_setting(settings, &["r2", "accountId"])
        ),
        "acl = private".to_string(),
        "no_check_bucket = true".to_string(),
        String::new(),
    ]);

    lines.join("\n")
}

fn run_rclone(args: &[String]) -> Result<(), String> {
    let rclone_path = resolve_tool("rclone", &["version"]);
    let output = Command::new(&rclone_path)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Could not start rclone at {}: {error}",
                rclone_path.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{stdout}\n{stderr}");
    let tail = combined
        .lines()
        .rev()
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    Err(if tail.trim().is_empty() {
        "Rclone exited without a diagnostic message.".to_string()
    } else {
        tail
    })
}

fn copy_to_rclone(
    local_path: &Path,
    remote_name: &str,
    bucket: &str,
    object_key: &str,
    config_path: &Path,
    copy_directory: bool,
    upload_concurrency: u64,
) -> Result<(), String> {
    let operation = if copy_directory { "copy" } else { "copyto" };
    let remote_target = format!(
        "{remote_name}:{}/{}",
        bucket.trim(),
        object_key.trim_matches('/')
    );
    let transfers = upload_concurrency.max(1).to_string();
    let checkers = (upload_concurrency.max(1) * 2).max(4).to_string();
    let args = vec![
        operation.to_string(),
        local_path.to_string_lossy().to_string(),
        remote_target,
        "--config".to_string(),
        config_path.to_string_lossy().to_string(),
        "--stats".to_string(),
        "1s".to_string(),
        "--stats-one-line".to_string(),
        "--retries".to_string(),
        "3".to_string(),
        "--low-level-retries".to_string(),
        "10".to_string(),
        "--retries-sleep".to_string(),
        "2s".to_string(),
        "--contimeout".to_string(),
        "15s".to_string(),
        "--timeout".to_string(),
        "30s".to_string(),
        "--transfers".to_string(),
        transfers,
        "--checkers".to_string(),
        checkers,
    ];

    run_rclone(&args)
}

fn sync_outputs(
    state: &tauri::State<'_, AppState>,
    settings: &Value,
    job_id: &str,
    source_path: &Path,
    output_directory: &Path,
    poster_path: Option<&PathBuf>,
    key_plan: &Value,
) -> Result<Value, String> {
    let archive_object_key = key_plan
        .get("archiveObjectKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "Storage key plan is missing an archive object key.".to_string())?;
    let distribution_object_key = key_plan
        .get("distributionObjectKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "Storage key plan is missing a distribution object key.".to_string())?;
    let poster_object_key = key_plan.get("posterObjectKey").and_then(Value::as_str);
    let config_directory = std::env::temp_dir().join(create_id("csn-media-bridge-rclone", 1));
    fs::create_dir_all(&config_directory)
        .map_err(|error| format!("Could not create {}: {error}", config_directory.display()))?;
    let config_path = config_directory.join("rclone.conf");
    fs::write(&config_path, rclone_config(settings))
        .map_err(|error| format!("Could not write {}: {error}", config_path.display()))?;
    let upload_concurrency = number_setting(settings, &["uploadConcurrency"], 10.0) as u64;
    let result = (|| -> Result<Value, String> {
        append_log(
            state,
            "info",
            "sync",
            "Uploading source archive to Backblaze B2.",
            Some(job_id.to_string()),
        )?;
        copy_to_rclone(
            source_path,
            "csnb2",
            string_setting(settings, &["b2", "bucket"]),
            archive_object_key,
            &config_path,
            false,
            upload_concurrency,
        )?;

        append_log(
            state,
            "info",
            "sync",
            "Uploading distribution package to Cloudflare R2.",
            Some(job_id.to_string()),
        )?;
        copy_to_rclone(
            output_directory,
            "csnr2",
            string_setting(settings, &["r2", "bucket"]),
            distribution_object_key,
            &config_path,
            true,
            upload_concurrency,
        )?;

        if let (Some(poster_object_key), Some(poster_path)) = (poster_object_key, poster_path) {
            append_log(
                state,
                "info",
                "sync",
                "Publishing poster image to Cloudflare R2.",
                Some(job_id.to_string()),
            )?;
            copy_to_rclone(
                poster_path,
                "csnr2",
                string_setting(settings, &["r2", "bucket"]),
                poster_object_key,
                &config_path,
                false,
                upload_concurrency,
            )?;
        }

        Ok(json!({
            "archiveObjectKey": archive_object_key,
            "distributionObjectKey": distribution_object_key,
            "posterObjectKey": poster_object_key,
            "posterUrl": poster_object_key.map(|object_key| {
                join_public_url(string_setting(settings, &["r2", "publicBaseUrl"]), object_key)
            }),
        }))
    })();

    let _ = fs::remove_dir_all(config_directory);
    result
}

fn convex_is_configured(settings: &Value) -> bool {
    !string_setting(settings, &["convex", "deploymentUrl"])
        .trim()
        .is_empty()
        && !string_setting(settings, &["convex", "mutationPath"])
            .trim()
            .is_empty()
}

fn derive_convex_function_path(settings: &Value, function_name: &str) -> String {
    let mutation_path = string_setting(settings, &["convex", "mutationPath"]).trim();
    let module_name = mutation_path
        .split(':')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("media/videos");

    format!("{module_name}:{function_name}")
}

fn final_stored_status(job: &Value) -> &'static str {
    if job.get("pipelineRoute").and_then(Value::as_str) == Some("review_draft") {
        "draft"
    } else {
        "ready"
    }
}

fn path_stem_fallback(source_name: &str) -> String {
    Path::new(source_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(source_name)
        .to_string()
}

fn insert_if_present(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(Value::Null) | None => {}
        Some(Value::Array(items)) if items.is_empty() => {}
        Some(Value::String(value)) if value.trim().is_empty() => {}
        Some(value) => {
            map.insert(key.to_string(), value);
        }
    }
}

fn job_string(job: &Value, key: &str) -> Option<Value> {
    trim_string(job.get(key)).map(Value::String)
}

fn build_convex_payload(job: &Value, status: &str) -> Result<Value, String> {
    let source_name = job
        .get("sourceName")
        .and_then(Value::as_str)
        .ok_or_else(|| "Completed job is missing a source name.".to_string())?;
    let archive_object_key = job
        .get("archiveObjectKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "Completed job is missing an archive object key.".to_string())?;
    let distribution_object_key = job
        .get("distributionObjectKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "Completed job is missing a distribution object key.".to_string())?;
    let playback_url = job
        .get("publicUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Completed job is missing a playback URL.".to_string())?;
    let mut payload = serde_json::Map::new();

    payload.insert(
        "title".to_string(),
        trim_string(job.get("title"))
            .unwrap_or_else(|| path_stem_fallback(source_name))
            .into(),
    );
    payload.insert("sourceFileName".to_string(), source_name.into());
    payload.insert("archiveObjectKey".to_string(), archive_object_key.into());
    payload.insert(
        "distributionObjectKey".to_string(),
        distribution_object_key.into(),
    );
    payload.insert("playbackUrl".to_string(), playback_url.into());
    payload.insert(
        "encoder".to_string(),
        job.get("encoder")
            .and_then(Value::as_str)
            .unwrap_or("software")
            .into(),
    );
    payload.insert(
        "durationSeconds".to_string(),
        Value::from(value_to_f64(job.get("durationSeconds")).unwrap_or(0.0)),
    );
    payload.insert("createdAt".to_string(), now_iso().into());
    payload.insert("status".to_string(), status.into());

    insert_if_present(
        &mut payload,
        "sourceFingerprint",
        job_string(job, "sourceFingerprint"),
    );
    insert_if_present(
        &mut payload,
        "requestedDelivery",
        job_string(job, "requestedDelivery"),
    );
    insert_if_present(
        &mut payload,
        "deliveryType",
        job_string(job, "deliveryType"),
    );
    insert_if_present(&mut payload, "contentType", job_string(job, "contentType"));
    insert_if_present(
        &mut payload,
        "masterPlaylistUrl",
        job_string(job, "manifestUrl"),
    );
    insert_if_present(&mut payload, "manifestUrl", job_string(job, "manifestUrl"));
    insert_if_present(
        &mut payload,
        "dashManifestUrl",
        job_string(job, "dashManifestUrl"),
    );
    insert_if_present(&mut payload, "posterUrl", job_string(job, "posterUrl"));
    insert_if_present(&mut payload, "sources", job.get("sources").cloned());
    insert_if_present(
        &mut payload,
        "sourceFileSizeBytes",
        job.get("sourceSizeBytes").cloned(),
    );
    insert_if_present(
        &mut payload,
        "sourceFrameRate",
        job.get("sourceFrameRate").cloned(),
    );
    insert_if_present(&mut payload, "sourceWidth", job.get("sourceWidth").cloned());
    insert_if_present(
        &mut payload,
        "sourceHeight",
        job.get("sourceHeight").cloned(),
    );
    insert_if_present(
        &mut payload,
        "sourceVideoCodec",
        job_string(job, "sourceVideoCodec"),
    );
    insert_if_present(
        &mut payload,
        "sourceAudioCodec",
        job_string(job, "sourceAudioCodec"),
    );
    insert_if_present(&mut payload, "tags", job.get("tags").cloned());
    insert_if_present(
        &mut payload,
        "playlistTitles",
        job.get("playlistTitles").cloned(),
    );
    insert_if_present(&mut payload, "description", job_string(job, "description"));
    insert_if_present(&mut payload, "series", job_string(job, "series"));
    insert_if_present(&mut payload, "recordedAt", job_string(job, "recordedAt"));
    insert_if_present(&mut payload, "projectName", job_string(job, "projectName"));
    insert_if_present(&mut payload, "eventName", job_string(job, "eventName"));
    insert_if_present(&mut payload, "cameraId", job_string(job, "cameraId"));
    insert_if_present(&mut payload, "sourceNode", job_string(job, "sourceNode"));
    insert_if_present(
        &mut payload,
        "reviewStatus",
        job_string(job, "reviewStatus"),
    );
    insert_if_present(
        &mut payload,
        "socialStatus",
        job_string(job, "socialStatus"),
    );
    insert_if_present(
        &mut payload,
        "scheduledPublishAt",
        job_string(job, "scheduledPublishAt"),
    );
    insert_if_present(
        &mut payload,
        "errorMessage",
        job_string(job, "errorMessage"),
    );

    // A recording converted for a client belongs to that client, not to the
    // station that did the work. The owner is never sent — only which job this
    // came from, so the library can read the owner off its own record. Sent only
    // for handoffs, so ordinary ingest is untouched by a backend that predates
    // the field.
    if let Some(handoff_job_id) = job_string(job, "sourceHandoffJobId") {
        insert_if_present(&mut payload, "liveHandoffJobId", Some(handoff_job_id));
        insert_if_present(&mut payload, "nodeKey", job_string(job, "handoffNodeKey"));
    }

    Ok(Value::Object(payload))
}

fn add_node_token(settings: &Value, mut args: Value) -> Value {
    let node_token = string_setting(settings, &["convex", "nodeToken"]).trim();
    if node_token.is_empty() {
        return args;
    }

    if let Some(map) = args.as_object_mut() {
        map.insert("nodeToken".to_string(), node_token.into());
    }

    args
}

async fn call_convex_function(
    settings: &Value,
    function_kind: &str,
    function_path: &str,
    args: Value,
) -> Result<Value, String> {
    let deployment_url = string_setting(settings, &["convex", "deploymentUrl"])
        .trim()
        .trim_end_matches('/');
    let request_body = json!({
        "path": function_path,
        "args": add_node_token(settings, args),
        "format": "json",
    });
    let response = reqwest::Client::new()
        .post(format!("{deployment_url}/api/{function_kind}"))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|error| format!("Could not reach Convex: {error}"))?;
    let http_status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("Could not read Convex response: {error}"))?;

    if !http_status.is_success() {
        return Err(format!("Convex HTTP {http_status}: {response_text}"));
    }

    let response_json = serde_json::from_str::<Value>(&response_text)
        .map_err(|error| format!("Could not parse Convex response: {error}"))?;

    match response_json.get("status").and_then(Value::as_str) {
        Some("success") => Ok(response_json.get("value").cloned().unwrap_or(Value::Null)),
        Some("error") => Err(response_json
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or("Convex function failed.")
            .to_string()),
        _ => Err(format!("Unexpected Convex response: {response_json}")),
    }
}

async fn call_convex_mutation(
    settings: &Value,
    function_path: &str,
    args: Value,
) -> Result<Value, String> {
    call_convex_function(settings, "mutation", function_path, args).await
}

async fn call_convex_action(
    settings: &Value,
    function_path: &str,
    args: Value,
) -> Result<Value, String> {
    call_convex_function(settings, "action", function_path, args).await
}

async fn call_convex_query(
    settings: &Value,
    function_path: &str,
    args: Value,
) -> Result<Value, String> {
    call_convex_function(settings, "query", function_path, args).await
}

async fn register_job_with_convex(
    settings: &Value,
    job: &Value,
    status: &str,
) -> Result<(), String> {
    call_create_vod_entry(settings, build_convex_payload(job, status)?).await
}

async fn list_all_stored_videos(settings: &Value) -> Result<Vec<Value>, String> {
    if !convex_is_configured(settings) {
        return Ok(Vec::new());
    }

    let query_path = derive_convex_function_path(settings, "paginateVideos");
    let mut videos = Vec::new();
    let mut cursor = Value::Null;

    for _ in 0..100 {
        let response = call_convex_query(
            settings,
            &query_path,
            json!({
                "paginationOpts": {
                    "cursor": cursor,
                    "numItems": 100,
                },
            }),
        )
        .await?;
        let page = response
            .get("page")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "Convex video pagination response is missing a page array.".to_string()
            })?;

        videos.extend(page.iter().cloned());

        if response
            .get("isDone")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            return Ok(videos);
        }

        cursor = response
            .get("continueCursor")
            .cloned()
            .unwrap_or(Value::Null);
    }

    Err("Convex video pagination did not finish after 100 pages.".to_string())
}

fn normalize_handoff_jobs(value: Value) -> Vec<Value> {
    if let Some(items) = value.as_array() {
        return items.clone();
    }

    value
        .get("page")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn set_handoff_jobs(
    state: &tauri::State<'_, AppState>,
    jobs: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let mut cached_jobs = state
        .live_handoff_jobs
        .lock()
        .map_err(|_| "Live handoff jobs lock is unavailable.".to_string())?;
    *cached_jobs = jobs;
    Ok(cached_jobs.clone())
}

fn upsert_handoff_job(
    state: &tauri::State<'_, AppState>,
    job: Value,
) -> Result<Vec<Value>, String> {
    let job_id = job
        .get("_id")
        .and_then(Value::as_str)
        .or_else(|| job.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| "Live handoff job does not include an id.".to_string())?;
    let mut cached_jobs = state
        .live_handoff_jobs
        .lock()
        .map_err(|_| "Live handoff jobs lock is unavailable.".to_string())?;

    if let Some(existing_job) = cached_jobs.iter_mut().find(|cached_job| {
        cached_job
            .get("_id")
            .and_then(Value::as_str)
            .or_else(|| cached_job.get("id").and_then(Value::as_str))
            == Some(job_id.as_str())
    }) {
        *existing_job = job;
    } else {
        cached_jobs.insert(0, job);
    }

    Ok(cached_jobs.clone())
}

fn patch_handoff_job(
    state: &tauri::State<'_, AppState>,
    job_id: &str,
    patch: Value,
) -> Result<Vec<Value>, String> {
    let patch_map = patch
        .as_object()
        .ok_or_else(|| "Live handoff patch must be a JSON object.".to_string())?;
    let mut cached_jobs = state
        .live_handoff_jobs
        .lock()
        .map_err(|_| "Live handoff jobs lock is unavailable.".to_string())?;

    if let Some(existing_job) = cached_jobs.iter_mut().find(|cached_job| {
        cached_job
            .get("_id")
            .and_then(Value::as_str)
            .or_else(|| cached_job.get("id").and_then(Value::as_str))
            == Some(job_id)
    }) {
        let job_map = existing_job
            .as_object_mut()
            .ok_or_else(|| "Cached live handoff job must be a JSON object.".to_string())?;

        for (key, value) in patch_map {
            job_map.insert(key.clone(), value.clone());
        }
        job_map.insert("updatedAt".to_string(), Value::String(now_iso()));
    } else {
        let mut next_job = serde_json::Map::new();
        next_job.insert("_id".to_string(), Value::String(job_id.to_string()));
        for (key, value) in patch_map {
            next_job.insert(key.clone(), value.clone());
        }
        next_job.insert("updatedAt".to_string(), Value::String(now_iso()));
        cached_jobs.insert(0, Value::Object(next_job));
    }

    Ok(cached_jobs.clone())
}

fn cached_handoff_jobs(state: &tauri::State<'_, AppState>) -> Result<Vec<Value>, String> {
    state
        .live_handoff_jobs
        .lock()
        .map_err(|_| "Live handoff jobs lock is unavailable.".to_string())
        .map(|jobs| jobs.clone())
}

fn emit_handoff_update(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(jobs) = cached_handoff_jobs(&state) {
        let _ = app.emit(LIVE_HANDOFF_UPDATED_EVENT, jobs);
    }
}

fn emit_handoff_patch(app: &tauri::AppHandle, job_id: &str, patch: Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    patch_handoff_job(&state, job_id, patch)?;
    emit_handoff_update(app);
    Ok(())
}

async fn mark_handoff_progress(
    settings: &Value,
    handoff_job_id: &str,
    node_key: &str,
    status: &str,
    progress: u64,
    stage: &str,
    message: &str,
) -> Result<(), String> {
    call_convex_mutation(
        settings,
        LIVE_HANDOFF_PROGRESS_MUTATION,
        json!({
            "handoffJobId": handoff_job_id,
            "nodeKey": node_key,
            "status": status,
            "progress": progress,
            "stage": stage,
            "message": message,
        }),
    )
    .await
    .map(|_| ())
}

async fn mark_handoff_failed(
    settings: &Value,
    handoff_job_id: &str,
    node_key: &str,
    error_message: &str,
) -> Result<(), String> {
    call_convex_mutation(
        settings,
        LIVE_HANDOFF_FAILED_MUTATION,
        json!({
            "handoffJobId": handoff_job_id,
            "nodeKey": node_key,
            "errorMessage": error_message,
        }),
    )
    .await
    .map(|_| ())
}

async fn renew_handoff_lease(
    settings: &Value,
    handoff_job_id: &str,
    node_key: &str,
) -> Result<(), String> {
    call_convex_mutation(
        settings,
        LIVE_HANDOFF_RENEW_MUTATION,
        json!({
            "handoffJobId": handoff_job_id,
            "nodeKey": node_key,
        }),
    )
    .await
    .map(|_| ())
}

async fn complete_handoff_job(
    settings: &Value,
    handoff_job_id: &str,
    node_key: &str,
    completed_job: &Value,
) -> Result<(), String> {
    call_convex_mutation(
        settings,
        LIVE_HANDOFF_COMPLETE_MUTATION,
        json!({
            "handoffJobId": handoff_job_id,
            "nodeKey": node_key,
            "archiveObjectKey": completed_job.get("archiveObjectKey").cloned().unwrap_or(Value::Null),
            "distributionObjectKey": completed_job.get("distributionObjectKey").cloned().unwrap_or(Value::Null),
            "playbackUrl": completed_job.get("publicUrl").cloned().unwrap_or(Value::Null),
            "manifestUrl": completed_job.get("manifestUrl").cloned().unwrap_or(Value::Null),
            "dashManifestUrl": completed_job.get("dashManifestUrl").cloned().unwrap_or(Value::Null),
            "posterUrl": completed_job.get("posterUrl").cloned().unwrap_or(Value::Null),
        }),
    )
    .await
    .map(|_| ())
}

fn start_handoff_lease_renewal(
    settings: Value,
    handoff_job_id: String,
    node_key: String,
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_signal = Arc::clone(&stop);

    thread::spawn(move || {
        while !stop_signal.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(45));
            if stop_signal.load(Ordering::Relaxed) {
                break;
            }
            let _ = tauri::async_runtime::block_on(renew_handoff_lease(
                &settings,
                &handoff_job_id,
                &node_key,
            ));
        }
    });

    stop
}

fn handoff_id(job: &Value) -> Result<String, String> {
    job.get("_id")
        .and_then(Value::as_str)
        .or_else(|| job.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| "Claimed live handoff job does not include an id.".to_string())
}

fn claimed_handoff_job(value: Value) -> Option<Value> {
    if value.is_null() {
        return None;
    }

    if let Some(job) = value.get("job") {
        if job.is_null() {
            None
        } else {
            Some(job.clone())
        }
    } else if value.is_object() {
        Some(value)
    } else {
        None
    }
}

fn handoff_source_file_name(job: &Value) -> String {
    let provider_video_id = job
        .get("providerVideoId")
        .and_then(Value::as_str)
        .unwrap_or("recording");
    format!(
        "{}.mp4",
        sanitize_file_name(provider_video_id, "recording.mp4").trim_end_matches(".mp4")
    )
}

async fn download_handoff_source(job: &Value, output_root: &Path) -> Result<PathBuf, String> {
    let handoff_job_id = handoff_id(job)?;
    let source_download_url = job
        .get("sourceDownloadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Claimed live handoff job does not include sourceDownloadUrl; sourceObjectKey downloads are not ported yet."
                .to_string()
        })?;
    let download_directory = output_root.join("live-handoff").join(&handoff_job_id);
    fs::create_dir_all(&download_directory).map_err(|error| {
        format!(
            "Could not create live handoff download folder {}: {error}",
            download_directory.display()
        )
    })?;
    let destination_path = download_directory.join(handoff_source_file_name(job));
    let mut response = reqwest::Client::new()
        .get(source_download_url)
        .send()
        .await
        .map_err(|error| format!("Could not download live recording: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Live recording download returned HTTP {}.",
            response.status()
        ));
    }

    let mut file = fs::File::create(&destination_path)
        .map_err(|error| format!("Could not create {}: {error}", destination_path.display()))?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read live recording download: {error}"))?
    {
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|error| format!("Could not write {}: {error}", destination_path.display()))?;
    }

    Ok(destination_path)
}

fn handoff_title(job: &Value) -> String {
    trim_string(job.get("eventName"))
        .or_else(|| trim_string(job.get("projectName")))
        .or_else(|| trim_string(job.get("providerVideoId")))
        .unwrap_or_else(|| "Live stream recording".to_string())
}

fn handoff_request(job: &Value, source_path: &Path, handoff_job_id: &str) -> Value {
    json!({
        "sourcePath": source_path.to_string_lossy().to_string(),
        "route": "web_streaming",
        "title": handoff_title(job),
        "projectName": trim_string(job.get("projectName")),
        "eventName": trim_string(job.get("eventName")),
        "recordedAt": trim_string(job.get("recordedAt")),
        "cameraId": trim_string(job.get("providerLiveInputId")),
        "sourceNode": format!("live-stream-handoff:{handoff_job_id}"),
        "requestedDelivery": "hls",
    })
}

fn handoff_job_error(job: &Value) -> String {
    trim_string(job.get("errorMessage"))
        .or_else(|| trim_string(job.get("message")))
        .unwrap_or_else(|| "Live handoff ingest job did not complete.".to_string())
}

fn process_live_handoff_job(app: tauri::AppHandle, handoff_job: Value, node_key: String) {
    let state = app.state::<AppState>();
    let settings = match state.settings.lock() {
        Ok(settings) => settings.clone(),
        Err(_) => {
            return;
        }
    };
    let handoff_job_id = match handoff_id(&handoff_job) {
        Ok(id) => id,
        Err(error) => {
            let _ = append_log(&state, "error", "live-handoff", error, None);
            emit_state_update(&app);
            return;
        }
    };
    let lease_stop =
        start_handoff_lease_renewal(settings.clone(), handoff_job_id.clone(), node_key.clone());
    let result = (|| -> Result<Value, String> {
        emit_handoff_patch(
            &app,
            &handoff_job_id,
            json!({
                "status": "downloading",
                "stage": "downloading",
                "progress": 5,
                "claimedByNodeKey": node_key.clone(),
                "message": "Downloading live recording source.",
            }),
        )?;
        tauri::async_runtime::block_on(mark_handoff_progress(
            &settings,
            &handoff_job_id,
            &node_key,
            "downloading",
            5,
            "downloading",
            "Downloading live recording source.",
        ))?;

        let download_root = output_root(&settings)?;
        let source_path =
            tauri::async_runtime::block_on(download_handoff_source(&handoff_job, &download_root))?;

        emit_handoff_patch(
            &app,
            &handoff_job_id,
            json!({
                "status": "processing",
                "stage": "queued-local-ingest",
                "progress": 20,
                "message": "Recording downloaded; queued local FFmpeg ingest.",
            }),
        )?;
        tauri::async_runtime::block_on(mark_handoff_progress(
            &settings,
            &handoff_job_id,
            &node_key,
            "processing",
            20,
            "queued-local-ingest",
            "Recording downloaded; queued local FFmpeg ingest.",
        ))?;

        let (_, ingest_job_id) = create_manual_job(
            &state,
            handoff_request(&handoff_job, &source_path, &handoff_job_id),
        )?;
        let ingest_job_id = ingest_job_id.ok_or_else(|| {
            "The downloaded recording is already present in the Tauri ingest queue.".to_string()
        })?;

        update_job(
            &state,
            &ingest_job_id,
            json!({
                "intakeMode": "live_handoff",
                "requestedDelivery": "hls",
                "sourceHandoffJobId": handoff_job_id.clone(),
                "handoffNodeKey": node_key.clone(),
            }),
        )?;
        emit_state_update(&app);

        process_queued_job(app.clone(), ingest_job_id.clone());
        let completed_job = get_job(&state, &ingest_job_id)?;

        if completed_job.get("status").and_then(Value::as_str) != Some("complete") {
            return Err(handoff_job_error(&completed_job));
        }

        emit_handoff_patch(
            &app,
            &handoff_job_id,
            json!({
                "status": "registering",
                "stage": "finalizing-handoff",
                "progress": 95,
                "message": "Finalizing live handoff with Convex.",
            }),
        )?;
        tauri::async_runtime::block_on(mark_handoff_progress(
            &settings,
            &handoff_job_id,
            &node_key,
            "registering",
            95,
            "finalizing-handoff",
            "Finalizing live handoff with Convex.",
        ))?;
        tauri::async_runtime::block_on(complete_handoff_job(
            &settings,
            &handoff_job_id,
            &node_key,
            &completed_job,
        ))?;

        Ok(completed_job)
    })();

    lease_stop.store(true, Ordering::Relaxed);

    match result {
        Ok(completed_job) => {
            let _ = emit_handoff_patch(
                &app,
                &handoff_job_id,
                json!({
                    "status": "completed",
                    "stage": "complete",
                    "progress": 100,
                    "completedAt": now_iso(),
                    "message": "Live recording packaged, uploaded, and registered.",
                    "archiveObjectKey": completed_job.get("archiveObjectKey").cloned().unwrap_or(Value::Null),
                    "distributionObjectKey": completed_job.get("distributionObjectKey").cloned().unwrap_or(Value::Null),
                    "playbackUrl": completed_job.get("publicUrl").cloned().unwrap_or(Value::Null),
                    "manifestUrl": completed_job.get("manifestUrl").cloned().unwrap_or(Value::Null),
                    "dashManifestUrl": completed_job.get("dashManifestUrl").cloned().unwrap_or(Value::Null),
                    "posterUrl": completed_job.get("posterUrl").cloned().unwrap_or(Value::Null),
                }),
            );
            let _ = append_log(
                &state,
                "info",
                "live-handoff",
                "Live handoff job completed.",
                Some(handoff_job_id),
            );
        }
        Err(error) => {
            let _ = tauri::async_runtime::block_on(mark_handoff_failed(
                &settings,
                &handoff_job_id,
                &node_key,
                &error,
            ));
            let _ = emit_handoff_patch(
                &app,
                &handoff_job_id,
                json!({
                    "status": "failed",
                    "stage": "failed",
                    "progress": 100,
                    "errorMessage": error,
                    "message": "Live handoff processing failed.",
                }),
            );
            let _ = append_log(
                &state,
                "error",
                "live-handoff",
                "Live handoff processing failed.",
                Some(handoff_job_id),
            );
        }
    }

    emit_state_update(&app);
}

fn classify_offload_file(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg") => "image",
        Some("mp4" | "mov" | "mkv" | "m4v" | "webm") => "video",
        _ => "other",
    }
}

fn visit_offload_directory(
    path: &Path,
    file_count: &mut u64,
    total_bytes: &mut u64,
    image_count: &mut u64,
    video_count: &mut u64,
    other_count: &mut u64,
) -> Result<(), String> {
    for entry in
        fs::read_dir(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read a directory entry: {error}"))?;
        let entry_path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", entry_path.display()))?;

        if metadata.is_dir() {
            visit_offload_directory(
                &entry_path,
                file_count,
                total_bytes,
                image_count,
                video_count,
                other_count,
            )?;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        *file_count += 1;
        *total_bytes += metadata.len();

        match classify_offload_file(&entry_path) {
            "image" => *image_count += 1,
            "video" => *video_count += 1,
            _ => *other_count += 1,
        }
    }

    Ok(())
}

fn inspect_offload_directory(path: PathBuf) -> Result<Value, String> {
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;

    if !metadata.is_dir() {
        return Err("Choose a folder, not a file.".to_string());
    }

    let mut file_count = 0;
    let mut total_bytes = 0;
    let mut image_count = 0;
    let mut video_count = 0;
    let mut other_count = 0;

    visit_offload_directory(
        &path,
        &mut file_count,
        &mut total_bytes,
        &mut image_count,
        &mut video_count,
        &mut other_count,
    )?;

    Ok(json!({
        "sourcePath": path.to_string_lossy().to_string(),
        "sourceName": file_name(&path),
        "fileCount": file_count,
        "totalBytes": total_bytes,
        "imageCount": image_count,
        "videoCount": video_count,
        "otherCount": other_count,
    }))
}

fn internet_reachable() -> bool {
    let address = SocketAddr::from(([1, 1, 1, 1], 443));
    TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_ok()
}

fn system_snapshot(settings: &Value) -> Value {
    let ffmpeg_path = resolved_tool_display("ffmpeg", &["-version"]);
    let ffprobe_path = resolved_tool_display("ffprobe", &["-version"]);
    let rclone_path = resolved_tool_display("rclone", &["version"]);
    let ffmpeg_available = ffmpeg_path.is_some();
    let ffprobe_available = ffprobe_path.is_some();
    let rclone_available = rclone_path.is_some();
    let watch_folder = string_setting(settings, &["watchFolder"]);
    let temp_output_path = string_setting(settings, &["tempOutputPath"]);
    let r2_public_base_url = normalized_url_setting(settings, &["r2", "publicBaseUrl"]);
    let watcher_healthy = path_exists(watch_folder);
    let mut notes = Vec::new();

    if !ffmpeg_available {
        notes.push("FFmpeg is not available.");
    }
    if !ffprobe_available {
        notes.push("FFprobe is not available.");
    }
    if !rclone_available {
        notes.push("Rclone is not available.");
    }
    if !watch_folder.trim().is_empty() && !watcher_healthy {
        notes.push("Watch folder does not exist.");
    }
    if !temp_output_path.trim().is_empty() && !path_exists(temp_output_path) {
        notes.push("Temp output folder does not exist.");
    }
    if r2_public_base_url.trim().is_empty() {
        notes.push("R2 public base URL is required for cloud playback URLs.");
    }
    if notes.is_empty() {
        notes.push("Tauri media worker checks passed.");
    }

    json!({
        "ffmpegAvailable": ffmpeg_available,
        "ffprobeAvailable": ffprobe_available,
        "rcloneAvailable": rclone_available,
        "ffmpegPath": ffmpeg_path,
        "ffprobePath": ffprobe_path,
        "rclonePath": rclone_path,
        "r2PublicBaseUrl": r2_public_base_url,
        "internetReachable": internet_reachable(),
        "watcherHealthy": watcher_healthy,
        "lastCheckedAt": now_iso(),
        "lastHeartbeatAt": now_iso(),
        "notes": notes,
    })
}

fn load_settings_from_state(state: &tauri::State<'_, AppState>) -> Result<Value, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?;

    let loaded_settings = read_settings_file()?;
    *settings = loaded_settings.clone();
    Ok(loaded_settings)
}

fn settings_snapshot_from_state(state: &tauri::State<'_, AppState>) -> Result<Value, String> {
    state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())
        .map(|settings| settings.clone())
}

fn state_snapshot(state: &tauri::State<'_, AppState>) -> Result<Value, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "Jobs lock is unavailable.".to_string())?
        .clone();
    let logs = state
        .logs
        .lock()
        .map_err(|_| "Logs lock is unavailable.".to_string())?
        .clone();

    let app_update = state
        .app_update
        .lock()
        .map_err(|_| "Update state is unavailable.".to_string())?
        .clone()
        .unwrap_or_else(|| {
            app_update_snapshot(
                if bool_setting(&settings, &["appUpdates", "enabled"], false) {
                    "idle"
                } else {
                    "disabled"
                },
                env!("CARGO_PKG_VERSION"),
                update_feed_url(&settings).as_deref(),
                "Not checked yet.",
            )
        });

    Ok(build_state(
        system_snapshot(&settings),
        jobs,
        logs,
        state.watching.load(Ordering::SeqCst),
        app_update,
    ))
}

fn append_log(
    state: &tauri::State<'_, AppState>,
    level: &str,
    source: &str,
    message: impl Into<String>,
    job_id: Option<String>,
) -> Result<(), String> {
    let mut logs = state
        .logs
        .lock()
        .map_err(|_| "Logs lock is unavailable.".to_string())?;
    let id = create_id("log", logs.len() + 1);

    logs.insert(
        0,
        json!({
            "id": id,
            "timestamp": now_iso(),
            "level": level,
            "source": source,
            "message": message.into(),
            "jobId": job_id,
        }),
    );
    logs.truncate(MAX_LOG_ENTRIES);

    Ok(())
}

fn update_job(
    state: &tauri::State<'_, AppState>,
    job_id: &str,
    patch: Value,
) -> Result<(), String> {
    let mut jobs = state
        .jobs
        .lock()
        .map_err(|_| "Jobs lock is unavailable.".to_string())?;
    let job = jobs
        .iter_mut()
        .find(|job| job.get("id").and_then(Value::as_str) == Some(job_id))
        .ok_or_else(|| format!("Could not find job {job_id}."))?;
    let job_map = job
        .as_object_mut()
        .ok_or_else(|| format!("Job {job_id} is not a JSON object."))?;
    let patch_map = patch
        .as_object()
        .ok_or_else(|| "Job patch must be a JSON object.".to_string())?;

    for (key, value) in patch_map {
        job_map.insert(key.clone(), value.clone());
    }
    job_map.insert("updatedAt".to_string(), Value::String(now_iso()));

    Ok(())
}

fn get_job(state: &tauri::State<'_, AppState>, job_id: &str) -> Result<Value, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "Jobs lock is unavailable.".to_string())?;

    jobs.iter()
        .find(|job| job.get("id").and_then(Value::as_str) == Some(job_id))
        .cloned()
        .ok_or_else(|| format!("Could not find job {job_id}."))
}

fn emit_state_update(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(snapshot) = state_snapshot(&state) {
        let _ = app.emit(STATE_UPDATED_EVENT, snapshot);
    }
}

fn emit_job_update(app: &tauri::AppHandle, job_id: &str, patch: Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    update_job(&state, job_id, patch)?;
    emit_state_update(app);
    Ok(())
}

fn resolve_delivery_type(job: &Value, settings: &Value, probe: &Value) -> &'static str {
    if job.get("requestedDelivery").and_then(Value::as_str) == Some("progressive") {
        return "progressive";
    }

    if job.get("requestedDelivery").and_then(Value::as_str) == Some("hls") {
        return "hls";
    }

    let max_progressive_duration =
        number_setting(settings, &["autoProgressiveMaxDurationSeconds"], 60.0);
    let duration_seconds = value_to_f64(probe.get("durationSeconds")).unwrap_or(0.0);

    if duration_seconds > 0.0 && duration_seconds <= max_progressive_duration {
        "progressive"
    } else {
        "hls"
    }
}

fn resolve_content_type(job: &Value, delivery_type: &str) -> String {
    trim_string(job.get("contentType")).unwrap_or_else(|| {
        if delivery_type == "progressive" {
            "clip".to_string()
        } else {
            "vod".to_string()
        }
    })
}

/* ------------------------------------------------------------- scrub previews */

/// Storyboard thumbnails for the scrub bar.
///
/// Frames are extracted on a fixed cadence, tiled into sprite sheets, and
/// described by a WebVTT file that maps each time range to a rectangle within a
/// sheet. That is the shape Plyr's `previewThumbnails` reads.
///
/// Sheets rather than one file per frame: a two-hour game is hundreds of
/// thumbnails, and hundreds of separate requests would be slower to fetch and
/// far more expensive to serve than a handful of tiled images.
const THUMBNAIL_DIRECTORY: &str = "thumbnails";
const THUMBNAIL_VTT_FILENAME: &str = "thumbnails.vtt";
const THUMBNAIL_WIDTH: u32 = 160;
const THUMBNAIL_HEIGHT: u32 = 90;
const THUMBNAIL_GRID_COLUMNS: u32 = 5;
const THUMBNAIL_GRID_ROWS: u32 = 5;
/// Roughly one frame per this many seconds, before the cap below applies.
const THUMBNAIL_TARGET_INTERVAL_SECONDS: f64 = 5.0;
/// A ceiling on total tiles, so a long recording does not produce a storyboard
/// bigger than the video it describes.
const THUMBNAIL_MAX_TILES: u32 = 600;

/// Seconds between frames: the target cadence for short videos, stretched for
/// long ones so the total stays under the cap.
fn thumbnail_interval_seconds(duration_seconds: f64) -> f64 {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return THUMBNAIL_TARGET_INTERVAL_SECONDS;
    }

    let at_target = duration_seconds / THUMBNAIL_TARGET_INTERVAL_SECONDS;
    if at_target <= THUMBNAIL_MAX_TILES as f64 {
        return THUMBNAIL_TARGET_INTERVAL_SECONDS;
    }

    (duration_seconds / THUMBNAIL_MAX_TILES as f64).ceil()
}

fn thumbnail_tile_count(duration_seconds: f64, interval: f64) -> u32 {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 || interval <= 0.0 {
        return 0;
    }

    ((duration_seconds / interval).ceil() as u32).max(1)
}

fn vtt_timestamp(seconds: f64) -> String {
    let clamped = seconds.max(0.0);
    let total_ms = (clamped * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let millis = total_ms % 1000;

    format!("{hours:02}:{minutes:02}:{secs:02}.{millis:03}")
}

/// The storyboard, as Plyr expects to read it.
///
/// Sprite files are referenced by bare name so they resolve next to the VTT
/// wherever it is served from — the local media proxy, the broker, or the
/// public bucket — without any of them needing to rewrite its contents.
fn build_thumbnail_vtt(duration_seconds: f64, interval: f64, tiles: u32) -> String {
    let per_sheet = THUMBNAIL_GRID_COLUMNS * THUMBNAIL_GRID_ROWS;
    let mut vtt = String::from("WEBVTT\n\n");

    for index in 0..tiles {
        let start = index as f64 * interval;
        let end = ((index + 1) as f64 * interval).min(duration_seconds.max(start + interval));

        let sheet = index / per_sheet;
        let within = index % per_sheet;
        let x = (within % THUMBNAIL_GRID_COLUMNS) * THUMBNAIL_WIDTH;
        let y = (within / THUMBNAIL_GRID_COLUMNS) * THUMBNAIL_HEIGHT;

        vtt.push_str(&format!(
            "{} --> {}\nsprite_{:03}.jpg#xywh={x},{y},{THUMBNAIL_WIDTH},{THUMBNAIL_HEIGHT}\n\n",
            vtt_timestamp(start),
            vtt_timestamp(end),
            sheet + 1,
        ));
    }

    vtt
}

/// Builds the sprite sheets and the storyboard beside the playback package.
///
/// Failure here is never fatal: a video without scrub previews still plays, so
/// callers log and carry on rather than failing an ingest over a nicety.
fn generate_scrub_thumbnails(
    source_path: &Path,
    output_directory: &Path,
    duration_seconds: f64,
) -> Result<PathBuf, String> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("Scrub previews need a known duration.".to_string());
    }

    let thumbnails_directory = output_directory.join(THUMBNAIL_DIRECTORY);
    fs::create_dir_all(&thumbnails_directory).map_err(|error| {
        format!(
            "Could not create {}: {error}",
            thumbnails_directory.display()
        )
    })?;

    let interval = thumbnail_interval_seconds(duration_seconds);
    let tiles = thumbnail_tile_count(duration_seconds, interval);

    // One decode pass produces every sheet: sample on the cadence, scale to the
    // tile size, and let ffmpeg lay them out.
    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-vf".to_string(),
        format!(
            "fps=1/{interval},scale={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease,pad={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:-1:-1:color=black,tile={THUMBNAIL_GRID_COLUMNS}x{THUMBNAIL_GRID_ROWS}"
        ),
        "-q:v".to_string(),
        "5".to_string(),
        "-an".to_string(),
        thumbnails_directory
            .join("sprite_%03d.jpg")
            .to_string_lossy()
            .to_string(),
    ])?;

    let vtt_path = thumbnails_directory.join(THUMBNAIL_VTT_FILENAME);
    fs::write(
        &vtt_path,
        build_thumbnail_vtt(duration_seconds, interval, tiles),
    )
    .map_err(|error| format!("Could not write {}: {error}", vtt_path.display()))?;

    Ok(vtt_path)
}

fn extract_poster(
    source_path: &Path,
    output_directory: &Path,
    duration_seconds: f64,
) -> Result<PathBuf, String> {
    let poster_path = output_directory.join("poster.jpg");
    let timestamp_seconds = if duration_seconds > 1.0 {
        (duration_seconds * 0.25).max(0.25)
    } else {
        0.25
    };
    let args = vec![
        "-y".to_string(),
        "-ss".to_string(),
        format!("{timestamp_seconds:.3}"),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        "2".to_string(),
        poster_path.to_string_lossy().to_string(),
    ];

    run_ffmpeg(&args)?;
    Ok(poster_path)
}

fn run_progressive_transcode(
    source_path: &Path,
    output_directory: &Path,
    has_audio: bool,
    encoder: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(output_directory)
        .map_err(|error| format!("Could not create {}: {error}", output_directory.display()))?;

    let playback_path = output_directory.join(PROGRESSIVE_H264_FILENAME);
    let mut args = vec!["-y".to_string()];
    args.extend(encoder_input_options(encoder));
    args.extend([
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
    ]);

    if has_audio {
        args.extend(["-map", "0:a:0?"].into_iter().map(String::from));
    }

    args.extend(
        [
            "-vf",
            "scale=w=1920:h=1080:force_original_aspect_ratio=decrease",
        ]
        .into_iter()
        .map(String::from),
    );
    args.extend(progressive_video_options(encoder));

    if has_audio {
        args.extend(
            ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"]
                .into_iter()
                .map(String::from),
        );
    }

    args.extend(
        ["-movflags", "+faststart", "-pix_fmt", "yuv420p"]
            .into_iter()
            .map(String::from),
    );
    args.push(playback_path.to_string_lossy().to_string());

    run_ffmpeg(&args)?;
    Ok(playback_path)
}

fn run_hls_transcode(
    source_path: &Path,
    output_directory: &Path,
    has_audio: bool,
    frame_rate: Option<f64>,
    duration_seconds: f64,
    encoder: &str,
) -> Result<(PathBuf, PathBuf), String> {
    for variant in HLS_VARIANTS {
        let variant_directory = output_directory
            .join("video")
            .join(variant.rendition_name());
        fs::create_dir_all(&variant_directory).map_err(|error| {
            format!("Could not create {}: {error}", variant_directory.display())
        })?;
    }

    let master_playlist_path = output_directory.join("master.m3u8");
    let output_playlist_pattern = output_directory
        .join("video")
        .join("%v")
        .join("stream.m3u8");
    let segment_pattern = output_directory
        .join("video")
        .join("%v")
        .join("chunk_%05d.m4s");
    let keyframe_interval = get_hls_keyframe_interval(frame_rate);
    let mut args = vec!["-y".to_string()];
    args.extend(encoder_input_options(encoder));
    args.extend([
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-filter_complex".to_string(),
        build_hls_scale_filter(),
    ]);

    for variant in HLS_VARIANTS {
        args.extend(["-map".to_string(), format!("[v{}]", variant.label)]);
        if has_audio {
            args.extend(["-map", "0:a:0?"].into_iter().map(String::from));
        }
    }

    args.extend(
        [
            "-g",
            &keyframe_interval.to_string(),
            "-keyint_min",
            &keyframe_interval.to_string(),
            "-sc_threshold",
            "0",
            "-force_key_frames",
            &format!("expr:gte(t,n_forced*{HLS_SEGMENT_DURATION_SECONDS})"),
            "-pix_fmt",
            "yuv420p",
        ]
        .into_iter()
        .map(String::from),
    );
    args.extend(hls_video_options(encoder));

    for (index, variant) in HLS_VARIANTS.iter().enumerate() {
        args.extend(
            [
                format!("-b:v:{index}"),
                variant.bitrate.to_string(),
                format!("-maxrate:v:{index}"),
                variant.maxrate.to_string(),
                format!("-bufsize:v:{index}"),
                variant.bufsize.to_string(),
            ]
            .into_iter(),
        );
    }

    if has_audio {
        args.extend(
            ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"]
                .into_iter()
                .map(String::from),
        );
    }

    let var_stream_map = if has_audio {
        HLS_VARIANTS
            .iter()
            .enumerate()
            .map(|(index, variant)| {
                format!("v:{index},a:{index},name:{}", variant.rendition_name())
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        HLS_VARIANTS
            .iter()
            .enumerate()
            .map(|(index, variant)| format!("v:{index},name:{}", variant.rendition_name()))
            .collect::<Vec<_>>()
            .join(" ")
    };

    args.extend(
        [
            "-f",
            "hls",
            "-hls_time",
            &HLS_SEGMENT_DURATION_SECONDS.to_string(),
            "-hls_playlist_type",
            "vod",
            "-hls_flags",
            "independent_segments",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-start_number",
            "1",
            "-master_pl_name",
            "master.m3u8",
            "-var_stream_map",
            &var_stream_map,
            "-hls_segment_filename",
            &segment_pattern.to_string_lossy(),
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(output_playlist_pattern.to_string_lossy().to_string());

    run_ffmpeg(&args)?;
    let dash_manifest_path = write_dash_manifest(output_directory, duration_seconds, has_audio)?;

    if !master_playlist_path.exists() {
        return Err("FFmpeg finished without creating a master playlist.".to_string());
    }

    Ok((master_playlist_path, dash_manifest_path))
}

/// Runs an encode with the encoder Settings asked for, and retries it once in
/// software if the hardware path gives out.
///
/// A GPU that fails part-way through should cost the job time, not the job
/// itself. Only failures that look like the hardware path are retried — a
/// missing input file is not going to encode any better in software. Returns
/// the encode's result; the job record is corrected in place when the retry
/// happens, so the library stores what really ran rather than what was asked
/// for.
fn encode_with_fallback<T>(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    job_id: &str,
    delivery_type: &str,
    preferred_encoder: &'static str,
    allow_software_fallback: bool,
    run: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    match run(preferred_encoder) {
        Ok(value) => Ok(value),
        Err(error) => {
            let can_fall_back = allow_software_fallback
                && preferred_encoder != "software"
                && is_hardware_acceleration_failure(&error);

            if !can_fall_back {
                return Err(error);
            }

            append_log(
                state,
                "warn",
                "transcode",
                format!(
                    "{} failed part-way through. Starting again in software.",
                    encoder_label(preferred_encoder)
                ),
                Some(job_id.to_string()),
            )?;
            emit_job_update(
                app,
                job_id,
                json!({
                    "encoder": "software",
                    "message": format!("Encoding {delivery_type} package with software libx264."),
                }),
            )?;

            run("software")
        }
    }
}

/* ------------------------------------------------------------------ retries */

/// Automatic retry for jobs that failed on the way to the cloud.
///
/// An ingest station is often somewhere with a poor uplink, and the pipeline's
/// most common failure by far is a transfer that stopped halfway. Those are
/// worth retrying on their own: the bytes are already on disk, rclone resumes
/// into the same object keys, and nothing has to be re-converted.
///
/// What is *not* retried is anything the machine will fail at again no matter
/// how long it waits — an unreadable file, a missing folder, a rejected
/// credential. Retrying those would bury a real problem under a queue that
/// looks busy, so they stop and ask for a person instead.
const JOB_RETRY_BACKOFF_SECONDS: &[u64] = &[30, 120, 300, 900, 1800];

/// Whether a failure is worth waiting out.
fn is_transient_failure(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();

    // Things that will not improve on their own, checked first: a permission
    // error mentioning "connection" should not be read as a network blip.
    let permanent = [
        "no such file",
        "not a directory",
        "permission denied",
        "unreadable",
        "invalid data",
        "moov atom not found",
        "unsupported",
        "checksum mismatch",
        "did not copy cleanly",
        "unauthorized",
        "forbidden",
        "invalid credentials",
        "access denied",
        "disk full",
        "no space left",
    ];
    if permanent.iter().any(|marker| lowered.contains(marker)) {
        return false;
    }

    let transient = [
        "connection",
        "could not reach",
        "timed out",
        "timeout",
        "temporarily",
        "network",
        "dns",
        "econnreset",
        "econnrefused",
        "etimedout",
        "broken pipe",
        "corrupted on transfer",
        "retries exhausted",
        "503",
        "502",
        "504",
        "429",
        "tls",
        "handshake",
    ];
    transient.iter().any(|marker| lowered.contains(marker))
}

fn retry_delay_seconds(attempt: usize) -> u64 {
    JOB_RETRY_BACKOFF_SECONDS
        .get(attempt)
        .copied()
        .unwrap_or_else(|| *JOB_RETRY_BACKOFF_SECONDS.last().unwrap_or(&1800))
}

/// How long until this job tries again, in the operator's words.
fn retry_wait_label(seconds: i64) -> String {
    if seconds <= 60 {
        "in under a minute".to_string()
    } else {
        let minutes = (seconds as f64 / 60.0).round() as i64;
        format!(
            "in about {minutes} minute{}",
            if minutes == 1 { "" } else { "s" }
        )
    }
}

/// Whether this station should retry a failed job on its own.
///
/// Not a live recording. Its retries belong to the library's queue: when the
/// conversion fails, the station reports it, the library takes the lease back,
/// and the recording is offered again — to this station or another. A local
/// retry running alongside that would finish the upload and then be refused at
/// registration, because the station no longer holds the job. And if someone
/// pressed Try again meanwhile, the recording would be converted twice.
fn retries_locally(job: &Value) -> bool {
    job.get("intakeMode").and_then(Value::as_str) != Some("live_handoff")
}

/// Marks a failed job as waiting for another go, or as needing a person.
fn schedule_job_retry(state: &tauri::State<'_, AppState>, job_id: &str, error: &str) {
    let job = match get_job(state, job_id) {
        Ok(job) => job,
        Err(_) => return,
    };

    if !retries_locally(&job) {
        let _ = update_job(
            state,
            job_id,
            json!({
                "status": "error",
                "stage": "error",
                "completedAt": now_iso(),
                "message": "Stopped. It is back on the Live streams page to try again.",
                "errorMessage": error,
                "nextRetryAt": Value::Null,
            }),
        );
        return;
    }

    let attempt = job.get("retryAttempt").and_then(Value::as_u64).unwrap_or(0) as usize;
    let attempts_left = attempt < JOB_RETRY_BACKOFF_SECONDS.len();

    if !is_transient_failure(error) || !attempts_left {
        let _ = update_job(
            state,
            job_id,
            json!({
                "status": "error",
                "stage": "error",
                "completedAt": now_iso(),
                "message": if attempts_left {
                    "This one stopped and will not fix itself."
                } else {
                    "Tried several times without getting through."
                },
                "errorMessage": error,
                "nextRetryAt": Value::Null,
            }),
        );
        return;
    }

    let delay = retry_delay_seconds(attempt);
    let next_retry_at = chrono::Utc::now() + chrono::Duration::seconds(delay as i64);

    let _ = update_job(
        state,
        job_id,
        json!({
            "status": "error",
            "stage": "error",
            "completedAt": Value::Null,
            "retryAttempt": attempt + 1,
            "nextRetryAt": next_retry_at.to_rfc3339(),
            "message": format!(
                "The connection dropped. Trying again {} (attempt {} of {}).",
                retry_wait_label(delay as i64),
                attempt + 2,
                JOB_RETRY_BACKOFF_SECONDS.len() + 1
            ),
            "errorMessage": error,
        }),
    );

    let _ = append_log(
        state,
        "warn",
        "sync",
        format!(
            "{} did not get through. Trying again {}.",
            trim_string(job.get("sourceName")).unwrap_or_default(),
            retry_wait_label(delay as i64)
        ),
        Some(job_id.to_string()),
    );
}

/// Jobs whose retry time has come round.
fn jobs_due_for_retry(state: &tauri::State<'_, AppState>) -> Vec<String> {
    let Ok(jobs) = state.jobs.lock() else {
        return Vec::new();
    };
    let now = chrono::Utc::now();

    jobs.iter()
        .filter(|job| job.get("status").and_then(Value::as_str) == Some("error"))
        // Belt and braces: a job scheduled by an older build is still skipped.
        .filter(|job| retries_locally(job))
        .filter_map(|job| {
            let due_at = trim_string(job.get("nextRetryAt"))?;
            let due_at = chrono::DateTime::parse_from_rfc3339(&due_at).ok()?;
            (due_at <= now)
                .then(|| job.get("id").and_then(Value::as_str).map(str::to_string))
                .flatten()
        })
        .collect()
}

/// Wakes every few seconds and restarts whatever is due.
///
/// Retries run one at a time, in the same queue the watcher feeds, so a backlog
/// that built up overnight drains at the speed the machine can actually encode
/// rather than all at once.
fn job_retry_loop(app: tauri::AppHandle) {
    loop {
        thread::sleep(Duration::from_secs(15));

        let due = {
            let state = app.state::<AppState>();
            jobs_due_for_retry(&state)
        };

        for job_id in due {
            {
                let state = app.state::<AppState>();
                let _ = update_job(
                    &state,
                    &job_id,
                    json!({
                        "status": "queued",
                        "stage": "file-ready",
                        "message": "Trying again where it left off.",
                        "errorMessage": Value::Null,
                        "nextRetryAt": Value::Null,
                    }),
                );
            }
            emit_state_update(&app);
            process_queued_job(app.clone(), job_id);
        }
    }
}

fn process_queued_job(app: tauri::AppHandle, job_id: String) {
    let state = app.state::<AppState>();
    let result = (|| -> Result<(), String> {
        let job = get_job(&state, &job_id)?;
        let source_path = PathBuf::from(
            job.get("sourcePath")
                .and_then(Value::as_str)
                .ok_or_else(|| "Queued job does not include a source path.".to_string())?,
        );
        let settings = state
            .settings
            .lock()
            .map_err(|_| "Settings lock is unavailable.".to_string())?
            .clone();
        let output_directory = output_root(&settings)?.join(&job_id);

        if output_directory.exists() {
            fs::remove_dir_all(&output_directory).map_err(|error| {
                format!("Could not clear {}: {error}", output_directory.display())
            })?;
        }
        fs::create_dir_all(&output_directory)
            .map_err(|error| format!("Could not create {}: {error}", output_directory.display()))?;

        emit_job_update(
            &app,
            &job_id,
            json!({
                "status": "checking",
                "stage": "fingerprinting",
                "startedAt": now_iso(),
                "message": "Inspecting source metadata with FFprobe.",
                "outputDirectory": output_directory.to_string_lossy().to_string(),
            }),
        )?;
        append_log(
            &state,
            "info",
            "transcode",
            "Inspecting source metadata with FFprobe.",
            Some(job_id.clone()),
        )?;

        let probe = probe_source(&source_path)?;
        let has_audio = probe
            .get("hasAudio")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let duration_seconds = value_to_f64(probe.get("durationSeconds")).unwrap_or(0.0);
        let frame_rate = value_to_f64(probe.get("frameRate"));
        let delivery_type = resolve_delivery_type(&job, &settings, &probe);
        let content_type = resolve_content_type(&job, delivery_type);
        let source_fingerprint = compute_source_fingerprint(&source_path)?;
        let key_plan = build_storage_key_plan(&settings, &job, &source_fingerprint);
        let archive_object_key = key_plan
            .get("archiveObjectKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let distribution_object_key = key_plan
            .get("distributionObjectKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let playback_relative_path = if delivery_type == "progressive" {
            PROGRESSIVE_H264_FILENAME
        } else {
            "master.m3u8"
        };
        let playback_object_key = join_object_key(&[
            Some(distribution_object_key.to_string()),
            Some(playback_relative_path.to_string()),
        ]);
        let manifest_url = if delivery_type == "hls" {
            Some(join_public_url(
                string_setting(&settings, &["r2", "publicBaseUrl"]),
                &join_object_key(&[
                    Some(distribution_object_key.to_string()),
                    Some("master.m3u8".to_string()),
                ]),
            ))
        } else {
            None
        };
        let dash_manifest_url = if delivery_type == "hls" {
            Some(join_public_url(
                string_setting(&settings, &["r2", "publicBaseUrl"]),
                &join_object_key(&[
                    Some(distribution_object_key.to_string()),
                    Some(DASH_MANIFEST_FILENAME.to_string()),
                ]),
            ))
        } else {
            None
        };
        let playback_url = join_public_url(
            string_setting(&settings, &["r2", "publicBaseUrl"]),
            &playback_object_key,
        );

        // The encoder Settings asks for, which on "Automatic" is whatever this
        // platform has: NVENC on Windows, VideoToolbox on macOS, software
        // elsewhere.
        let preferred_encoder = effective_encoder(&settings);
        let allow_software_fallback = bool_setting(&settings, &["autoFallbackToSoftware"], true);

        emit_job_update(
            &app,
            &job_id,
            json!({
                "status": "encoding",
                "stage": "encoding",
                "message": format!(
                    "Encoding {delivery_type} package with {}.",
                    encoder_label(preferred_encoder)
                ),
                "encodingProgress": 5,
                "encoder": preferred_encoder,
                "deliveryType": delivery_type,
                "contentType": content_type,
                "durationSeconds": probe.get("durationSeconds").cloned().unwrap_or(Value::Null),
                "sourceFrameRate": probe.get("frameRate").cloned().unwrap_or(Value::Null),
                "sourceWidth": probe.get("width").cloned().unwrap_or(Value::Null),
                "sourceHeight": probe.get("height").cloned().unwrap_or(Value::Null),
                "sourceVideoCodec": probe.get("videoCodec").cloned().unwrap_or(Value::Null),
                "sourceAudioCodec": probe.get("audioCodec").cloned().unwrap_or(Value::Null),
                "sourceFingerprint": source_fingerprint,
                "archiveObjectKey": archive_object_key,
                "distributionObjectKey": distribution_object_key,
                "manifestUrl": manifest_url,
                "dashManifestUrl": dash_manifest_url,
                "publicUrl": playback_url,
            }),
        )?;
        append_log(
            &state,
            "info",
            "transcode",
            format!(
                "Encoding {delivery_type} package with {}.",
                encoder_label(preferred_encoder)
            ),
            Some(job_id.clone()),
        )?;

        let extract_poster_enabled = bool_setting(&settings, &["extractPosterFrame"], true);
        let scrub_thumbnails_enabled = bool_setting(&settings, &["generateScrubThumbnails"], true);

        if delivery_type == "progressive" {
            let playback_path = encode_with_fallback(
                &app,
                &state,
                &job_id,
                delivery_type,
                preferred_encoder,
                allow_software_fallback,
                |encoder| {
                    run_progressive_transcode(&source_path, &output_directory, has_audio, encoder)
                },
            )?;
            let poster_path = if extract_poster_enabled {
                extract_poster(&playback_path, &output_directory, duration_seconds).ok()
            } else {
                None
            };

            // A video without scrub previews still plays, so a failure here is
            // logged and stepped over rather than failing the ingest.
            if scrub_thumbnails_enabled {
                if let Err(error) =
                    generate_scrub_thumbnails(&playback_path, &output_directory, duration_seconds)
                {
                    let _ = append_log(
                        &state,
                        "warn",
                        "transcode",
                        format!("Could not build scrub previews: {error}"),
                        Some(job_id.clone()),
                    );
                }
            }
            let source_object_key = join_object_key(&[
                Some(distribution_object_key.to_string()),
                Some(PROGRESSIVE_H264_FILENAME.to_string()),
            ]);

            if storage_is_configured(&settings) {
                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": "uploading",
                        "stage": "uploading-archive",
                        "message": "Uploading source archive and progressive package.",
                        "encodingProgress": 100,
                        "uploadProgress": 1,
                        "posterPath": poster_path.as_ref().map(|path| path.to_string_lossy().to_string()),
                    }),
                )?;
                let sync_result = sync_outputs(
                    &state,
                    &settings,
                    &job_id,
                    &source_path,
                    &output_directory,
                    poster_path.as_ref(),
                    &key_plan,
                )?;
                let poster_url = sync_result.get("posterUrl").cloned().unwrap_or(Value::Null);

                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": if convex_is_configured(&settings) { "registering" } else { "complete" },
                        "stage": if convex_is_configured(&settings) { "registering" } else { "complete" },
                        "completedAt": if convex_is_configured(&settings) { Value::Null } else { Value::String(now_iso()) },
                        "message": if convex_is_configured(&settings) {
                            "Registering progressive media entry with Convex."
                        } else {
                            "Progressive package uploaded. Configure Convex settings to enable Tauri registration."
                        },
                        "encodingProgress": 100,
                        "uploadProgress": 100,
                        "publicUrl": playback_url,
                        "posterUrl": poster_url,
                        "sources": [
                            {
                                "codec": "h264",
                                "mimeType": "video/mp4",
                                "url": playback_url,
                                "objectKey": source_object_key,
                            }
                        ],
                    }),
                )?;

                if convex_is_configured(&settings) {
                    let ready_job = get_job(&state, &job_id)?;
                    tauri::async_runtime::block_on(register_job_with_convex(
                        &settings,
                        &ready_job,
                        final_stored_status(&ready_job),
                    ))?;
                    append_log(
                        &state,
                        "info",
                        "convex",
                        "Registered progressive media entry with Convex.",
                        Some(job_id.clone()),
                    )?;
                    emit_job_update(
                        &app,
                        &job_id,
                        json!({
                            "status": "complete",
                            "stage": "complete",
                            "completedAt": now_iso(),
                            "retryAttempt": 0,
                            "nextRetryAt": Value::Null,
                            "message": "Progressive package uploaded and registered with Convex.",
                        }),
                    )?;
                }
            } else {
                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": "complete",
                        "stage": "complete",
                        "completedAt": now_iso(),
                        "retryAttempt": 0,
                        "nextRetryAt": Value::Null,
                        "message": "Local progressive package is complete. Configure B2/R2 settings to enable Tauri uploads.",
                        "encodingProgress": 100,
                        "uploadProgress": 0,
                        "publicUrl": file_url(&playback_path),
                        "posterPath": poster_path.as_ref().map(|path| path.to_string_lossy().to_string()),
                        "posterUrl": poster_path.as_ref().map(|path| file_url(path)),
                        "sources": [
                            {
                                "codec": "h264",
                                "mimeType": "video/mp4",
                                "url": file_url(&playback_path),
                                "objectKey": PROGRESSIVE_H264_FILENAME,
                            }
                        ],
                    }),
                )?;
            }
        } else {
            let (master_playlist_path, dash_manifest_path) = encode_with_fallback(
                &app,
                &state,
                &job_id,
                delivery_type,
                preferred_encoder,
                allow_software_fallback,
                |encoder| {
                    run_hls_transcode(
                        &source_path,
                        &output_directory,
                        has_audio,
                        frame_rate,
                        duration_seconds,
                        encoder,
                    )
                },
            )?;
            let poster_path = if extract_poster_enabled {
                extract_poster(&source_path, &output_directory, duration_seconds).ok()
            } else {
                None
            };

            if scrub_thumbnails_enabled {
                if let Err(error) =
                    generate_scrub_thumbnails(&source_path, &output_directory, duration_seconds)
                {
                    let _ = append_log(
                        &state,
                        "warn",
                        "transcode",
                        format!("Could not build scrub previews: {error}"),
                        Some(job_id.clone()),
                    );
                }
            }

            if storage_is_configured(&settings) {
                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": "uploading",
                        "stage": "uploading-archive",
                        "message": "Uploading source archive and CMAF HLS/DASH package.",
                        "encodingProgress": 100,
                        "uploadProgress": 1,
                        "masterPlaylistPath": master_playlist_path.to_string_lossy().to_string(),
                        "posterPath": poster_path.as_ref().map(|path| path.to_string_lossy().to_string()),
                    }),
                )?;
                let sync_result = sync_outputs(
                    &state,
                    &settings,
                    &job_id,
                    &source_path,
                    &output_directory,
                    poster_path.as_ref(),
                    &key_plan,
                )?;
                let poster_url = sync_result.get("posterUrl").cloned().unwrap_or(Value::Null);

                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": if convex_is_configured(&settings) { "registering" } else { "complete" },
                        "stage": if convex_is_configured(&settings) { "registering" } else { "complete" },
                        "completedAt": if convex_is_configured(&settings) { Value::Null } else { Value::String(now_iso()) },
                        "message": if convex_is_configured(&settings) {
                            "Registering VOD entry with Convex."
                        } else {
                            "CMAF HLS/DASH package uploaded. Configure Convex settings to enable Tauri registration."
                        },
                        "encodingProgress": 100,
                        "uploadProgress": 100,
                        "masterPlaylistPath": master_playlist_path.to_string_lossy().to_string(),
                        "manifestUrl": manifest_url,
                        "dashManifestUrl": dash_manifest_url,
                        "publicUrl": playback_url,
                        "posterUrl": poster_url,
                    }),
                )?;

                if convex_is_configured(&settings) {
                    let ready_job = get_job(&state, &job_id)?;
                    tauri::async_runtime::block_on(register_job_with_convex(
                        &settings,
                        &ready_job,
                        final_stored_status(&ready_job),
                    ))?;
                    append_log(
                        &state,
                        "info",
                        "convex",
                        "Registered VOD entry with Convex.",
                        Some(job_id.clone()),
                    )?;
                    emit_job_update(
                        &app,
                        &job_id,
                        json!({
                            "status": "complete",
                            "stage": "complete",
                            "completedAt": now_iso(),
                            "retryAttempt": 0,
                            "nextRetryAt": Value::Null,
                            "message": "CMAF HLS/DASH package uploaded and registered with Convex.",
                        }),
                    )?;
                }
            } else {
                emit_job_update(
                    &app,
                    &job_id,
                    json!({
                        "status": "complete",
                        "stage": "complete",
                        "completedAt": now_iso(),
                        "retryAttempt": 0,
                        "nextRetryAt": Value::Null,
                        "message": "Local CMAF HLS/DASH package is complete. Configure B2/R2 settings to enable Tauri uploads.",
                        "encodingProgress": 100,
                        "uploadProgress": 0,
                        "masterPlaylistPath": master_playlist_path.to_string_lossy().to_string(),
                        "manifestUrl": file_url(&master_playlist_path),
                        "dashManifestUrl": file_url(&dash_manifest_path),
                        "publicUrl": file_url(&master_playlist_path),
                        "posterPath": poster_path.as_ref().map(|path| path.to_string_lossy().to_string()),
                        "posterUrl": poster_path.as_ref().map(|path| file_url(path)),
                    }),
                )?;
            }
        }

        append_log(
            &state,
            "info",
            "transcode",
            "Local FFmpeg package completed.",
            Some(job_id.clone()),
        )?;
        Ok(())
    })();

    if let Err(error) = result {
        // Decides between waiting it out and asking for a person.
        schedule_job_retry(&state, &job_id, &error);
        let _ = append_log(&state, "error", "transcode", error, Some(job_id));
        emit_state_update(&app);
    }
}

fn create_manual_job(
    state: &tauri::State<'_, AppState>,
    request: Value,
) -> Result<(Value, Option<String>), String> {
    let source_path = trim_string(request.get("sourcePath"))
        .ok_or_else(|| "Choose a source file before sending content to the queue.".to_string())?;
    let route = trim_string(request.get("route")).unwrap_or_else(|| "web_streaming".to_string());
    let (requested_delivery, content_type, review_status, social_status) =
        manual_pipeline_preset(&route)?;
    let path = PathBuf::from(&source_path);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_default();

    if !SUPPORTED_INGEST_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Manual intake supports {} files.",
            SUPPORTED_INGEST_EXTENSIONS.join(", ")
        ));
    }

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;

    if !metadata.is_file() {
        return Err("Choose a video file for manual intake.".to_string());
    }

    {
        let jobs = state
            .jobs
            .lock()
            .map_err(|_| "Jobs lock is unavailable.".to_string())?;
        if jobs.iter().any(|job| {
            job.get("sourcePath").and_then(Value::as_str) == Some(source_path.as_str())
                && !matches!(
                    job.get("status").and_then(Value::as_str),
                    Some("complete" | "error")
                )
        }) {
            drop(jobs);
            append_log(
                state,
                "warn",
                "system",
                format!(
                    "Skipped {} because it is already in the Tauri queue.",
                    file_name(&path)
                ),
                None,
            )?;
            return Ok((state_snapshot(state)?, None));
        }
    }

    let probe = match probe_source(&path) {
        Ok(probe) => probe,
        Err(error) => {
            append_log(
                state,
                "warn",
                "transcode",
                format!(
                    "FFprobe metadata is unavailable for {}: {error}",
                    file_name(&path)
                ),
                None,
            )?;
            json!({
                "durationSeconds": null,
                "hasAudio": null,
                "frameRate": null,
                "width": null,
                "height": null,
                "videoCodec": null,
                "audioCodec": null,
            })
        }
    };
    let now = now_iso();
    let job_id = create_id("tauri-job", 1);
    let title = trim_string(request.get("title"));

    let job = json!({
        "id": job_id,
        "intakeMode": "manual",
        "pipelineRoute": route,
        "title": title,
        "sourcePath": source_path,
        "sourceName": file_name(&path),
        "sourceSizeBytes": metadata.len(),
        "sourceFrameRate": probe.get("frameRate").cloned().unwrap_or(Value::Null),
        "sourceWidth": probe.get("width").cloned().unwrap_or(Value::Null),
        "sourceHeight": probe.get("height").cloned().unwrap_or(Value::Null),
        "sourceVideoCodec": probe.get("videoCodec").cloned().unwrap_or(Value::Null),
        "sourceAudioCodec": probe.get("audioCodec").cloned().unwrap_or(Value::Null),
        "createdAt": now,
        "updatedAt": now,
        "startedAt": null,
        "completedAt": null,
        "status": "queued",
        "stage": "file-ready",
        "message": "Manual intake is queued in the Tauri host.",
        "encodingProgress": 0,
        "uploadProgress": 0,
        "encoder": null,
        "requestedDelivery": requested_delivery,
        "deliveryType": null,
        "contentType": content_type,
        "outputDirectory": null,
        "masterPlaylistPath": null,
        "manifestUrl": null,
        "dashManifestUrl": null,
        "posterPath": null,
        "posterUrl": null,
        "publicUrl": null,
        "sources": [],
        "archiveObjectKey": null,
        "distributionObjectKey": null,
        "sourceFingerprint": null,
        "durationSeconds": probe.get("durationSeconds").cloned().unwrap_or(Value::Null),
        "tags": string_array(request.get("tags")),
        "playlistTitles": string_array(request.get("playlistTitles")),
        "description": trim_string(request.get("description")),
        "series": trim_string(request.get("series")),
        "recordedAt": trim_string(request.get("recordedAt")),
        "projectName": trim_string(request.get("projectName")),
        "eventName": trim_string(request.get("eventName")),
        "cameraId": trim_string(request.get("cameraId")),
        "sourceNode": trim_string(request.get("sourceNode")),
        "reviewStatus": review_status,
        "socialStatus": social_status,
        "scheduledPublishAt": null,
        "sidecarPath": null,
        "errorMessage": null,
        "retryAttempt": 0,
        "nextRetryAt": null,
    });

    {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "Jobs lock is unavailable.".to_string())?;
        jobs.insert(0, job);
        jobs.truncate(MAX_JOB_HISTORY);
    }

    append_log(
        state,
        "info",
        "system",
        "Manual intake queued in the Tauri host.",
        Some(job_id.clone()),
    )?;

    Ok((state_snapshot(state)?, Some(job_id)))
}

/* ------------------------------------------------------------- rclone removal */

/// rclone has several ways of saying "it was already gone", and none of them is
/// a failure for a delete: the object we wanted removed is not there.
fn is_missing_remote_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("directory not found")
        || lowered.contains("object not found")
        || lowered.contains("not found")
        || lowered.contains("did not find section in config file")
}

/// Writes a throwaway rclone config, hands its path to `run`, and clears the
/// directory away afterwards whether or not the command succeeded — that file
/// holds both sets of storage credentials in plain text.
fn with_rclone_config<T>(
    settings: &Value,
    run: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let config_directory = std::env::temp_dir().join(create_id("csn-media-bridge-rclone", 1));
    fs::create_dir_all(&config_directory)
        .map_err(|error| format!("Could not create {}: {error}", config_directory.display()))?;
    let config_path = config_directory.join("rclone.conf");

    let result = match fs::write(&config_path, rclone_config(settings)) {
        Ok(()) => run(&config_path),
        Err(error) => Err(format!(
            "Could not write {}: {error}",
            config_path.display()
        )),
    };

    let _ = fs::remove_dir_all(&config_directory);
    result
}

fn remote_target(remote_name: &str, bucket: &str, object_key: &str) -> String {
    format!(
        "{remote_name}:{}/{}",
        bucket.trim(),
        object_key.trim_matches('/')
    )
}

/// Removes one object. An object that was already gone counts as removed.
fn delete_remote_file(
    settings: &Value,
    remote_name: &str,
    bucket: &str,
    object_key: &str,
) -> Result<(), String> {
    let object_key = object_key.trim_matches('/').to_string();
    if object_key.is_empty() {
        return Ok(());
    }

    with_rclone_config(settings, |config_path| {
        match run_rclone(&[
            "deletefile".to_string(),
            remote_target(remote_name, bucket, &object_key),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
        ]) {
            Ok(()) => Ok(()),
            Err(error) if is_missing_remote_error(&error) => Ok(()),
            Err(error) => Err(error),
        }
    })
}

/// Removes a prefix and everything beneath it.
fn purge_remote_prefix(
    settings: &Value,
    remote_name: &str,
    bucket: &str,
    prefix: &str,
) -> Result<(), String> {
    let prefix = prefix.trim_matches('/').to_string();
    if prefix.is_empty() {
        return Err("Remote prefix is required before purging cloud objects.".to_string());
    }

    with_rclone_config(settings, |config_path| {
        match run_rclone(&[
            "purge".to_string(),
            remote_target(remote_name, bucket, &prefix),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
        ]) {
            Ok(()) => Ok(()),
            Err(error) if is_missing_remote_error(&error) => Ok(()),
            Err(error) => Err(error),
        }
    })
}

/* -------------------------------------------------- stored video reasoning */

/// These mirror `src/shared/media.ts`. The renderer and the host have to agree
/// about what a stored record means, so the rules are ported rather than
/// re-invented: a record states its delivery type when it knows it, and is read
/// from its URLs and sources when it does not.
fn is_hls_url(value: Option<&str>) -> bool {
    value
        .map(|value| {
            let lowered = value.to_ascii_lowercase();
            lowered.ends_with(".m3u8") || lowered.contains(".m3u8?")
        })
        .unwrap_or(false)
}

fn video_str<'a>(video: &'a Value, key: &str) -> Option<&'a str> {
    video
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn video_sources(video: &Value) -> Vec<Value> {
    video
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn infer_stored_delivery_type(video: &Value) -> &'static str {
    if let Some(delivery_type) = video_str(video, "deliveryType") {
        return if delivery_type == "hls" {
            "hls"
        } else {
            "progressive"
        };
    }

    if !video_sources(video).is_empty() {
        return "progressive";
    }

    if is_hls_url(video_str(video, "manifestUrl"))
        || is_hls_url(video_str(video, "masterPlaylistUrl"))
        || is_hls_url(video_str(video, "playbackUrl"))
    {
        return "hls";
    }

    "progressive"
}

fn infer_stored_content_type(video: &Value) -> String {
    if let Some(content_type) = video_str(video, "contentType") {
        return content_type.to_string();
    }

    if infer_stored_delivery_type(video) == "progressive" {
        "clip".to_string()
    } else {
        "vod".to_string()
    }
}

fn stored_manifest_url(video: &Value) -> Option<String> {
    if let Some(url) = video_str(video, "manifestUrl") {
        return Some(url.to_string());
    }

    if let Some(url) = video_str(video, "masterPlaylistUrl") {
        return Some(url.to_string());
    }

    if is_hls_url(video_str(video, "playbackUrl")) {
        return video_str(video, "playbackUrl").map(str::to_string);
    }

    None
}

fn public_url_for(settings: &Value, object_key: &str, file_name: Option<&str>) -> String {
    let key = join_object_key(&[Some(object_key.to_string()), file_name.map(str::to_string)]);
    join_public_url(string_setting(settings, &["r2", "publicBaseUrl"]), &key)
}

/// Mirrors `buildPlaybackUrlFromStoredVideo` in `ConvexService`: prefer the
/// H.264 rendition, else keep the existing file name under the current public
/// base, else fall back to the distribution folder itself.
fn stored_progressive_playback_url(settings: &Value, video: &Value) -> String {
    let distribution_object_key = video_str(video, "distributionObjectKey").unwrap_or_default();

    let h264_object_key = video_sources(video).into_iter().find_map(|source| {
        if source.get("codec").and_then(Value::as_str) == Some("h264") {
            source
                .get("objectKey")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        }
    });

    if let Some(object_key) = h264_object_key.filter(|key| !key.trim().is_empty()) {
        return public_url_for(settings, &object_key, None);
    }

    if let Some(playback_url) = video_str(video, "playbackUrl") {
        return match reqwest::Url::parse(playback_url) {
            Ok(parsed) => {
                let file_name = parsed
                    .path_segments()
                    .and_then(|segments| segments.last())
                    .unwrap_or_default()
                    .to_string();
                public_url_for(
                    settings,
                    distribution_object_key,
                    if file_name.is_empty() {
                        None
                    } else {
                        Some(file_name.as_str())
                    },
                )
            }
            Err(_) => playback_url.to_string(),
        };
    }

    public_url_for(settings, distribution_object_key, None)
}

/// The library record as the `createVodEntry` mutation wants it. Repairing a
/// record re-registers the whole thing rather than patching fields, because the
/// mutation is an upsert keyed on the archive object.
fn stored_video_entry_payload(video: &Value, overrides: Value) -> Value {
    let mut payload = serde_json::Map::new();
    let source_file_name = video_str(video, "sourceFileName").unwrap_or_default();

    payload.insert(
        "title".to_string(),
        Value::String(
            video_str(video, "title")
                .map(str::to_string)
                .unwrap_or_else(|| path_stem_fallback(source_file_name)),
        ),
    );
    payload.insert(
        "sourceFileName".to_string(),
        Value::String(source_file_name.to_string()),
    );
    payload.insert("createdAt".to_string(), Value::String(now_iso()));

    for key in [
        "sourceFingerprint",
        "requestedDelivery",
        "archiveObjectKey",
        "distributionObjectKey",
        "encoder",
        "durationSeconds",
        "sourceFileSizeBytes",
        "sourceFrameRate",
        "sourceWidth",
        "sourceHeight",
        "sourceVideoCodec",
        "sourceAudioCodec",
        "tags",
        "playlistTitles",
        "description",
        "series",
        "recordedAt",
        "projectName",
        "eventName",
        "cameraId",
        "sourceNode",
        "reviewStatus",
        "socialStatus",
        "scheduledPublishAt",
        "errorMessage",
        "status",
        "sourceVideoId",
        "clipAspectRatio",
        "clipInSeconds",
        "clipOutSeconds",
    ] {
        if let Some(value) = video.get(key) {
            if !value.is_null() {
                payload.insert(key.to_string(), value.clone());
            }
        }
    }

    if let Some(overrides) = overrides.as_object() {
        for (key, value) in overrides {
            if value.is_null() {
                payload.remove(key);
            } else {
                payload.insert(key.clone(), value.clone());
            }
        }
    }

    Value::Object(payload)
}

/// Posts a ready-made library record, retrying once without `dashManifestUrl`
/// for deployments whose validator predates that field.
async fn call_create_vod_entry(settings: &Value, payload: Value) -> Result<(), String> {
    let mutation_path = string_setting(settings, &["convex", "mutationPath"]).trim();
    let first_result = call_convex_mutation(settings, mutation_path, payload.clone()).await;

    if first_result.is_ok() || payload.get("dashManifestUrl").is_none() {
        return first_result.map(|_| ());
    }

    let mut fallback_payload = payload
        .as_object()
        .cloned()
        .ok_or_else(|| "Convex payload must be a JSON object.".to_string())?;
    fallback_payload.remove("dashManifestUrl");
    call_convex_mutation(settings, mutation_path, Value::Object(fallback_payload))
        .await
        .map(|_| ())
}

fn require_convex(settings: &Value) -> Result<(), String> {
    if convex_is_configured(settings) {
        Ok(())
    } else {
        Err("Convex settings are incomplete. Add the deployment URL and mutation path.".to_string())
    }
}

/* ------------------------------------------------------------------ encoders */

/// Which encoder this machine should reach for, mirroring `src/main/lib/encoder.ts`.
///
/// The setting wins when it names one; otherwise the platform decides — NVENC
/// on Windows, VideoToolbox on macOS, software everywhere else.
fn effective_encoder(settings: &Value) -> &'static str {
    match string_setting(settings, &["hardwareEncoderOverride"]).trim() {
        "nvenc" => "nvenc",
        "videotoolbox" => "videotoolbox",
        "software" => "software",
        _ => {
            if cfg!(target_os = "windows") {
                "nvenc"
            } else if cfg!(target_os = "macos") {
                "videotoolbox"
            } else {
                "software"
            }
        }
    }
}

fn encoder_input_options(encoder: &str) -> Vec<String> {
    if encoder == "nvenc" {
        vec!["-hwaccel".to_string(), "cuda".to_string()]
    } else {
        Vec::new()
    }
}

/// Progressive MP4 encodes at a quality target on software, and at a rate
/// target on the hardware encoders, which have no CRF equivalent.
fn progressive_video_options(encoder: &str) -> Vec<String> {
    match encoder {
        "nvenc" => [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-cq",
            "21",
            "-b:v",
            "0",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "videotoolbox" => ["-c:v", "h264_videotoolbox", "-b:v", "8M"]
            .into_iter()
            .map(String::from)
            .collect(),
        _ => ["-c:v", "libx264", "-preset", "medium", "-crf", "21"]
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

/// The HLS ladder sets an explicit bitrate per rung, so the codec options here
/// only choose the encoder and its speed.
fn hls_video_options(encoder: &str) -> Vec<String> {
    match encoder {
        "nvenc" => ["-c:v", "h264_nvenc", "-preset", "p5"]
            .into_iter()
            .map(String::from)
            .collect(),
        "videotoolbox" => ["-c:v", "h264_videotoolbox", "-realtime", "true"]
            .into_iter()
            .map(String::from)
            .collect(),
        _ => ["-c:v", "libx264", "-preset", "medium"]
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

/// How the encoder reads in a log line or on the Videos screen.
fn encoder_label(encoder: &str) -> &'static str {
    match encoder {
        "nvenc" => "NVENC",
        "videotoolbox" => "VideoToolbox",
        _ => "software libx264",
    }
}

fn trim_video_options(encoder: &str) -> Vec<String> {
    match encoder {
        "nvenc" => [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-cq",
            "21",
            "-b:v",
            "0",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "videotoolbox" => ["-c:v", "h264_videotoolbox", "-b:v", "8M"]
            .into_iter()
            .map(String::from)
            .collect(),
        _ => ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

/// Whether an ffmpeg failure looks like the GPU path giving out, in which case
/// the same work is worth retrying in software.
fn is_hardware_acceleration_failure(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("cuda")
        || lowered.contains("nvenc")
        || lowered.contains("videotoolbox")
        || lowered.contains("out of memory")
        || lowered.contains("cannot allocate memory")
        || lowered.contains("hardware accelerator failed")
        || lowered.contains("vt decoder")
}

/* ---------------------------------------------------------------------- trim */

fn run_trim_export(
    source_path: &Path,
    output_path: &Path,
    in_point_seconds: f64,
    clip_duration_seconds: f64,
    encoder: &str,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let _ = fs::remove_file(output_path);

    let mut args = vec!["-y".to_string()];
    args.extend(encoder_input_options(encoder));
    args.extend(
        [
            "-ss".to_string(),
            format!("{in_point_seconds:.3}"),
            "-i".to_string(),
            source_path.to_string_lossy().to_string(),
            "-t".to_string(),
            format!("{clip_duration_seconds:.3}"),
        ]
        .into_iter(),
    );
    args.extend(trim_video_options(encoder));
    args.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-pix_fmt",
            "yuv420p",
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(output_path.to_string_lossy().to_string());

    run_ffmpeg(&args)
}

/* ------------------------------------------------------------------- posters */

/// Four frames spread across the video, never right at the head or the tail —
/// the first and last quarter-second of a recording is usually black.
fn poster_candidate_times(duration_seconds: f64) -> Vec<f64> {
    let safe_duration = if duration_seconds.is_finite() && duration_seconds > 0.0 {
        duration_seconds
    } else {
        12.0
    };
    let ceiling = (safe_duration - 0.25).max(0.25);

    let mut times = Vec::new();
    for fraction in [0.12_f64, 0.32, 0.56, 0.82] {
        let timestamp = ((safe_duration * fraction).max(0.25) * 100.0).round() / 100.0;
        let clamped = (timestamp.min((ceiling * 100.0).round() / 100.0) * 100.0).round() / 100.0;
        if !times
            .iter()
            .any(|existing: &f64| (*existing - clamped).abs() < f64::EPSILON)
        {
            times.push(clamped);
        }
    }

    times.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    times
}

fn format_poster_label(timestamp_seconds: f64) -> String {
    let total_seconds = timestamp_seconds.max(0.0).round() as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// Where a replacement poster for an existing asset is written. Canonical
/// assets keep posters in their own top-level prefix so an R2 lifecycle rule
/// can expire social renders without touching published artwork; legacy assets
/// keep theirs beside the playback package.
fn resolve_poster_object_key(distribution_object_key: &str) -> String {
    let normalized = distribution_object_key.trim_matches('/');

    for prefix in [STREAMING_PREFIX, LEGACY_STREAMING_PREFIX] {
        let streaming_prefix = format!("{prefix}/");
        if let Some(remainder) = normalized.strip_prefix(&streaming_prefix) {
            let asset_key = remainder.split('/').next().unwrap_or_default().trim();
            if !asset_key.is_empty() {
                return join_object_key(&[
                    Some(POSTERS_PREFIX.to_string()),
                    Some(asset_key.to_string()),
                    Some("default.jpg".to_string()),
                ]);
            }
        }
    }

    join_object_key(&[Some(normalized.to_string()), Some("poster.jpg".to_string())])
}

/* -------------------------------------------------------- archive presigning */

/// B2's S3 endpoint carries its region in the hostname, and SigV4 needs the
/// region to match. Deriving it from the endpoint keeps that to one field an
/// operator has to get right instead of two that have to agree.
fn parse_b2_endpoint(endpoint: &str) -> Option<(String, String)> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let host = trimmed.strip_prefix("https://")?;
    let region = host.strip_prefix("s3.")?.strip_suffix(".backblazeb2.com")?;

    if region.is_empty()
        || !region
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return None;
    }

    Some((trimmed.to_string(), region.to_ascii_lowercase()))
}

/// Explains what is missing rather than returning a bare false, so the screen
/// can name the setting to fill in instead of just disabling a button.
fn archive_unavailable_reason(settings: &Value) -> Option<String> {
    if string_setting(settings, &["b2", "bucket"])
        .trim()
        .is_empty()
    {
        return Some(
            "Set the Backblaze B2 bucket in Settings before previewing archived masters."
                .to_string(),
        );
    }

    if string_setting(settings, &["b2", "keyId"]).trim().is_empty()
        || string_setting(settings, &["b2", "applicationKey"])
            .trim()
            .is_empty()
    {
        return Some(
            "Backblaze B2 credentials are required before previewing archived masters.".to_string(),
        );
    }

    let endpoint = string_setting(settings, &["b2", "s3Endpoint"]).trim();
    if endpoint.is_empty() {
        return Some(
            "Set the B2 S3 endpoint in Settings, for example https://s3.us-west-004.backblazeb2.com."
                .to_string(),
        );
    }

    if parse_b2_endpoint(endpoint).is_none() {
        return Some(format!(
            "\"{endpoint}\" is not a Backblaze S3 endpoint. It should look like https://s3.us-west-004.backblazeb2.com."
        ));
    }

    None
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn hmac_sha256(key: &[u8], message: &str) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(message: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(message.as_bytes());
    hex_encode(&hasher.finalize())
}

/// Percent-encodes one path segment the way SigV4 canonicalisation wants:
/// unreserved characters pass through, everything else becomes %XX, and the
/// slashes between segments are added by the caller.
fn uri_encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// A time-limited URL for exactly one archived object, signed here rather than
/// fetched through a service, so the vault stays private and the credentials
/// never leave this process.
///
/// This is plain SigV4 query-string signing — the same thing the AWS SDK's
/// presigner does, minus the SDK. Only presigning is done this way; moving
/// actual bytes stays on the rclone path, which already has retries and
/// progress.
fn presign_b2_object_url(
    settings: &Value,
    object_key: &str,
    expires_in_seconds: u64,
) -> Result<String, String> {
    if let Some(reason) = archive_unavailable_reason(settings) {
        return Err(reason);
    }

    let (endpoint, region) = parse_b2_endpoint(string_setting(settings, &["b2", "s3Endpoint"]))
        .ok_or_else(|| "B2 S3 endpoint is not configured.".to_string())?;
    let host = endpoint
        .strip_prefix("https://")
        .ok_or_else(|| "B2 S3 endpoint must be an https address.".to_string())?
        .to_string();

    let bucket = string_setting(settings, &["b2", "bucket"])
        .trim()
        .to_string();
    let access_key_id = string_setting(settings, &["b2", "keyId"])
        .trim()
        .to_string();
    let secret_access_key = string_setting(settings, &["b2", "applicationKey"])
        .trim()
        .to_string();

    let normalized_key = object_key.trim().trim_start_matches('/');
    if normalized_key.is_empty() {
        return Err("An archive object key is required.".to_string());
    }

    let expires_in_seconds = expires_in_seconds.clamp(60, 24 * 60 * 60);
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let canonical_uri = format!(
        "/{}/{}",
        uri_encode_segment(&bucket),
        normalized_key
            .split('/')
            .map(uri_encode_segment)
            .collect::<Vec<_>>()
            .join("/")
    );
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let credential = format!("{access_key_id}/{credential_scope}");

    // Query parameters have to be sorted by key, and every value encoded.
    let canonical_query_string = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date.clone()),
        ("X-Amz-Expires", expires_in_seconds.to_string()),
        ("X-Amz-SignedHeaders", "host".to_string()),
    ]
    .into_iter()
    .map(|(key, value)| format!("{}={}", uri_encode_segment(key), uri_encode_segment(&value)))
    .collect::<Vec<_>>()
    .join("&");

    let canonical_request = format!(
        "GET\n{canonical_uri}\n{canonical_query_string}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD"
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(&canonical_request)
    );

    let date_key = hmac_sha256(format!("AWS4{secret_access_key}").as_bytes(), &date_stamp);
    let region_key = hmac_sha256(&date_key, &region);
    let service_key = hmac_sha256(&region_key, "s3");
    let signing_key = hmac_sha256(&service_key, "aws4_request");
    let signature = hex_encode(&hmac_sha256(&signing_key, &string_to_sign));

    Ok(format!(
        "{endpoint}{canonical_uri}?{canonical_query_string}&X-Amz-Signature={signature}"
    ))
}

/// Pulls one archived object back down to a local path via rclone.
fn download_from_b2(
    settings: &Value,
    source_object_key: &str,
    local_file_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = local_file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    let bucket = string_setting(settings, &["b2", "bucket"])
        .trim()
        .to_string();
    let source_object_key = source_object_key.trim_matches('/').to_string();

    with_rclone_config(settings, |config_path| {
        run_rclone(&[
            "copyto".to_string(),
            format!("csnb2:{bucket}/{source_object_key}"),
            local_file_path.to_string_lossy().to_string(),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
            "--stats".to_string(),
            "1s".to_string(),
            "--stats-one-line".to_string(),
            "--retries".to_string(),
            "3".to_string(),
            "--low-level-retries".to_string(),
            "10".to_string(),
            "--retries-sleep".to_string(),
            "2s".to_string(),
            "--contimeout".to_string(),
            "15s".to_string(),
            "--timeout".to_string(),
            "30s".to_string(),
        ])
    })
}

/* ----------------------------------------------------------- stream library */

/// Recordings already stored in Cloudflare Stream, and getting them out.
///
/// This station never holds a Cloudflare credential. It asks the library for
/// the list and, per recording, for one download link — the library holds the
/// Stream token and decides which recordings this station may see. The bytes
/// then come straight here: into the Backblaze archive through `rclone rcat`
/// without touching local disk, or into a file the operator chose.
///
/// The archive layout matches `scripts/archive-stream-to-b2.mjs`, and both find
/// already-archived recordings by the Stream uid folder, so a recording
/// archived by either is recognised by the other.
const STREAM_LIBRARY_LIST_ACTION: &str = "media/liveStream:listStreamRecordings";
const STREAM_LIBRARY_DOWNLOAD_ACTION: &str = "media/liveStream:requestStreamDownload";
const STREAM_TRANSFERS_UPDATED_EVENT: &str = "media-bridge:stream-transfers-updated";
/// Stream takes minutes to package a long broadcast as an MP4.
const STREAM_DOWNLOAD_READY_TIMEOUT_SECONDS: u64 = 45 * 60;
const STREAM_DOWNLOAD_POLL_SECONDS: u64 = 5;
const MAX_STREAM_TRANSFER_HISTORY: usize = 50;

/// Stream uids are 32 lowercase hex characters. Checked before one reaches an
/// object key or a request, so nothing from the window can steer a path.
fn is_stream_uid(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|character| character.is_ascii_hexdigit())
}

struct StreamArchiveKeys {
    video: String,
    sidecar: String,
}

/// `masters/<client>/<YYYY-MM-DD>/<stream uid>/<name>.mp4`, beside a `.json`.
/// The client groups a team's archive; the uid folder is what marks a
/// recording as archived.
fn stream_archive_keys(
    uid: &str,
    title: Option<&str>,
    client_name: Option<&str>,
    created_at: Option<&str>,
) -> StreamArchiveKeys {
    let folder = join_object_key(&[
        Some(MASTERS_PREFIX.to_string()),
        Some(slugify_segment(client_name, UNASSIGNED_PROJECT_SEGMENT)),
        Some(date_segment(created_at)),
        Some(uid.to_ascii_lowercase()),
    ]);
    let name = slugify_segment(title, uid);

    StreamArchiveKeys {
        video: format!("{folder}/{name}.mp4"),
        sidecar: format!("{folder}/{name}.json"),
    }
}

/// The Stream uids present in an `rclone lsjson` of `masters/`. Only a folder
/// named like a uid holding an MP4 counts — ingest's 16-character asset folders
/// sit in the same tree and must not be mistaken for one.
fn archived_stream_uids(listing: &Value) -> Vec<String> {
    let mut uids = listing
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("Path").and_then(Value::as_str)?;
                    if !path.to_ascii_lowercase().ends_with(".mp4") {
                        return None;
                    }
                    let segments = path.split('/').collect::<Vec<_>>();
                    let folder = segments
                        .len()
                        .checked_sub(2)
                        .and_then(|index| segments.get(index))?;
                    is_stream_uid(folder).then(|| folder.to_ascii_lowercase())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    uids.sort();
    uids.dedup();
    uids
}

fn emit_stream_transfers(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(transfers) = state.stream_transfers.lock() {
        let _ = app.emit(STREAM_TRANSFERS_UPDATED_EVENT, transfers.clone());
    };
}

fn patch_stream_transfer(app: &tauri::AppHandle, uid: &str, patch: Value) {
    let state = app.state::<AppState>();
    if let Ok(mut transfers) = state.stream_transfers.lock() {
        if let Some(transfer) = transfers
            .iter_mut()
            .find(|transfer| transfer.get("uid").and_then(Value::as_str) == Some(uid))
        {
            if let (Some(target), Some(fields)) = (transfer.as_object_mut(), patch.as_object()) {
                for (key, value) in fields {
                    target.insert(key.clone(), value.clone());
                }
                target.insert("updatedAt".to_string(), now_iso().into());
            }
        }
    };
    emit_stream_transfers(app);
}

fn stream_transfer_is_active(transfer: &Value) -> bool {
    matches!(
        transfer.get("status").and_then(Value::as_str),
        Some("preparing" | "transferring" | "verifying")
    )
}

/// What the window sends to start a transfer. The title, client and date only
/// shape the archive key and sidecar; the uid is the one thing checked, here and
/// again by the library before it hands out a link.
fn stream_recording_request(request: &Value) -> Result<(String, Value), String> {
    let uid = trim_string(request.get("uid"))
        .map(|uid| uid.to_ascii_lowercase())
        .filter(|uid| is_stream_uid(uid))
        .ok_or_else(|| "That is not a Stream recording id.".to_string())?;
    Ok((uid, request.clone()))
}

/// Registers a transfer, refusing a second one for the same recording.
fn begin_stream_transfer(
    state: &tauri::State<'_, AppState>,
    uid: &str,
    kind: &str,
    recording: &Value,
    destination: &str,
) -> Result<(Value, Arc<AtomicBool>), String> {
    let mut transfers = state
        .stream_transfers
        .lock()
        .map_err(|_| "Transfers lock is unavailable.".to_string())?;

    if transfers.iter().any(|transfer| {
        transfer.get("uid").and_then(Value::as_str) == Some(uid)
            && stream_transfer_is_active(transfer)
    }) {
        return Err("This recording is already being transferred.".to_string());
    }

    transfers.retain(|transfer| transfer.get("uid").and_then(Value::as_str) != Some(uid));
    let snapshot = json!({
        "uid": uid,
        "kind": kind,
        "title": trim_string(recording.get("name")).unwrap_or_else(|| uid.to_string()),
        "clientName": trim_string(recording.get("clientName")),
        "status": "preparing",
        "message": "Asking Stream to prepare the file.",
        "percentPrepared": 0,
        "bytesDone": 0,
        "bytesTotal": Value::Null,
        "destination": destination,
        "errorMessage": Value::Null,
        "startedAt": now_iso(),
        "updatedAt": now_iso(),
    });
    transfers.insert(0, snapshot.clone());
    transfers.truncate(MAX_STREAM_TRANSFER_HISTORY);
    drop(transfers);

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .stream_transfer_cancels
        .lock()
        .map_err(|_| "Transfers lock is unavailable.".to_string())?
        .insert(uid.to_string(), Arc::clone(&cancel));

    Ok((snapshot, cancel))
}

const STREAM_TRANSFER_CANCELED: &str = "Canceled.";

/// Waits for Stream to finish packaging the MP4 and returns its link.
fn wait_for_stream_download(
    app: &tauri::AppHandle,
    settings: &Value,
    uid: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let started = std::time::Instant::now();

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(STREAM_TRANSFER_CANCELED.to_string());
        }

        let response = tauri::async_runtime::block_on(call_convex_action(
            settings,
            STREAM_LIBRARY_DOWNLOAD_ACTION,
            json!({ "uid": uid }),
        ))
        .map_err(|error| plain_handoff_error(&error))?;

        match response.get("status").and_then(Value::as_str) {
            Some("ready") => {
                return trim_string(response.get("url"))
                    .ok_or_else(|| "Stream said the file was ready but sent no link.".to_string());
            }
            Some("error") => {
                return Err(trim_string(response.get("errorMessage"))
                    .unwrap_or_else(|| "Stream could not prepare this recording.".to_string()));
            }
            _ => {
                patch_stream_transfer(
                    app,
                    uid,
                    json!({
                        "percentPrepared": response.get("percentComplete").and_then(Value::as_f64).unwrap_or(0.0),
                        "message": "Stream is preparing the file. Long events take a few minutes.",
                    }),
                );
            }
        }

        if started.elapsed() > Duration::from_secs(STREAM_DOWNLOAD_READY_TIMEOUT_SECONDS) {
            return Err("Stream was still preparing the file after 45 minutes.".to_string());
        }

        // Short sleeps, so Cancel is answered promptly.
        for _ in 0..(STREAM_DOWNLOAD_POLL_SECONDS * 4) {
            if cancel.load(Ordering::SeqCst) {
                return Err(STREAM_TRANSFER_CANCELED.to_string());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Feeds the download to `sink` chunk by chunk, reporting progress and
/// honouring Cancel. Returns the byte count and SHA-256.
fn stream_download_into(
    app: &tauri::AppHandle,
    uid: &str,
    url: &str,
    cancel: &AtomicBool,
    mut sink: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<(u64, String, Option<u64>), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not prepare the download: {error}"))?;
    let mut response = tauri::async_runtime::block_on(client.get(url).send())
        .map_err(|error| format!("Could not start the download: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Stream refused the download (HTTP {}). If this recording uses signed links, the library has to sign them first.",
            response.status()
        ));
    }

    let total = response.content_length();
    patch_stream_transfer(
        app,
        uid,
        json!({ "status": "transferring", "bytesTotal": total, "percentPrepared": 100, "message": Value::Null }),
    );

    let mut hash = Sha256::new();
    let mut done: u64 = 0;
    let mut last_report = std::time::Instant::now();

    while let Some(chunk) = tauri::async_runtime::block_on(response.chunk())
        .map_err(|error| format!("The download was interrupted: {error}"))?
    {
        if cancel.load(Ordering::SeqCst) {
            return Err(STREAM_TRANSFER_CANCELED.to_string());
        }
        sink(&chunk)?;
        hash.update(&chunk);
        done += chunk.len() as u64;

        if last_report.elapsed() >= Duration::from_millis(500) {
            patch_stream_transfer(app, uid, json!({ "bytesDone": done }));
            last_report = std::time::Instant::now();
        }
    }

    if done == 0 {
        return Err("Stream sent an empty file.".to_string());
    }
    if let Some(total) = total.filter(|total| *total != done) {
        return Err(format!("The download stopped at {done} of {total} bytes."));
    }

    patch_stream_transfer(app, uid, json!({ "bytesDone": done }));
    Ok((done, hex_encode(&hash.finalize()), total))
}

/// Starts `rclone rcat` writing to `target`, with stdin as the object body.
fn spawn_rclone_rcat(
    config_path: &Path,
    target: &str,
    size: Option<u64>,
) -> Result<std::process::Child, String> {
    let rclone_path = resolve_tool("rclone", &["version"]);
    let mut command = Command::new(&rclone_path);
    command
        .args(["rcat", target, "--config"])
        .arg(config_path)
        .args(["--low-level-retries", "10"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    if let Some(size) = size {
        command.args(["--size", &size.to_string()]);
    }
    command.spawn().map_err(|error| {
        format!(
            "Could not start rclone at {}: {error}",
            rclone_path.display()
        )
    })
}

fn finish_rclone_rcat(mut child: std::process::Child) -> Result<(), String> {
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .map_err(|error| format!("rclone did not finish: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail = stderr
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(if tail.trim().is_empty() {
        "rclone stopped without saying why.".to_string()
    } else {
        tail
    })
}

fn archive_stream_recording_inner(
    app: &tauri::AppHandle,
    settings: &Value,
    uid: &str,
    recording: &Value,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let keys = stream_archive_keys(
        uid,
        trim_string(recording.get("name")).as_deref(),
        trim_string(recording.get("clientName")).as_deref(),
        trim_string(recording.get("createdAt")).as_deref(),
    );
    let bucket = string_setting(settings, &["b2", "bucket"])
        .trim()
        .to_string();
    let url = wait_for_stream_download(app, settings, uid, cancel)?;

    with_rclone_config(settings, |config_path| {
        let video_target = remote_target("csnb2", &bucket, &keys.video);

        // The declared length lets rclone allocate the upload; the request is
        // made once, inside the streaming call, so it is only known there. A
        // HEAD first would cost a round trip for a hint rclone can live without.
        let mut child: Option<std::process::Child> = None;
        let streamed = stream_download_into(app, uid, &url, cancel, |chunk| {
            if child.is_none() {
                child = Some(spawn_rclone_rcat(config_path, &video_target, None)?);
            }
            let stdin = child
                .as_mut()
                .and_then(|process| process.stdin.as_mut())
                .ok_or_else(|| "rclone closed its input.".to_string())?;
            stdin
                .write_all(chunk)
                .map_err(|_| "rclone stopped accepting the upload.".to_string())
        });

        let (bytes, sha256, _) = match streamed {
            Ok(result) => result,
            Err(error) => {
                if let Some(mut process) = child {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                return Err(error);
            }
        };
        finish_rclone_rcat(child.ok_or_else(|| "Nothing was uploaded.".to_string())?)?;

        patch_stream_transfer(
            app,
            uid,
            json!({ "status": "verifying", "message": "Checking the archive copy." }),
        );
        let listing = run_rclone_capture(&[
            "lsjson".to_string(),
            video_target.clone(),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
            "--files-only".to_string(),
        ])?;
        let stored = serde_json::from_str::<Value>(&listing)
            .ok()
            .and_then(|entries| {
                entries
                    .get(0)
                    .and_then(|entry| entry.get("Size"))
                    .and_then(Value::as_u64)
            });
        if stored != Some(bytes) {
            return Err(format!(
                "The archive holds {} bytes but {bytes} were sent.",
                stored
                    .map(|size| size.to_string())
                    .unwrap_or_else(|| "no".to_string())
            ));
        }

        let sidecar = serde_json::to_vec_pretty(&json!({
            "source": "cloudflare_stream",
            "uid": uid,
            "name": trim_string(recording.get("name")),
            "clientName": trim_string(recording.get("clientName")),
            "created": trim_string(recording.get("createdAt")),
            "durationSeconds": recording.get("durationSeconds").cloned().unwrap_or(Value::Null),
            "liveInputId": trim_string(recording.get("liveInputId")),
            "streamSizeBytes": recording.get("sizeBytes").cloned().unwrap_or(Value::Null),
            "archivedSizeBytes": bytes,
            "sha256": sha256,
            "archivedAt": now_iso(),
            "archivedBy": desktop_node_key().ok(),
            "objectKey": keys.video,
        }))
        .map_err(|error| format!("Could not describe the recording: {error}"))?;
        let mut sidecar_child = spawn_rclone_rcat(
            config_path,
            &remote_target("csnb2", &bucket, &keys.sidecar),
            Some(sidecar.len() as u64),
        )?;
        sidecar_child
            .stdin
            .as_mut()
            .ok_or_else(|| "rclone closed its input.".to_string())?
            .write_all(&sidecar)
            .map_err(|_| "rclone stopped accepting the description.".to_string())?;
        finish_rclone_rcat(sidecar_child)?;

        Ok(keys.video.clone())
    })
}

fn download_stream_recording_inner(
    app: &tauri::AppHandle,
    settings: &Value,
    uid: &str,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let url = wait_for_stream_download(app, settings, uid, cancel)?;

    // Written beside the destination and renamed at the end, so a stopped
    // download never leaves something that looks like a finished file.
    let partial = destination.with_extension("mp4.part");
    let mut file = fs::File::create(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;

    let result = stream_download_into(app, uid, &url, cancel, |chunk| {
        file.write_all(chunk)
            .map_err(|error| format!("Could not write {}: {error}", partial.display()))
    })
    .and_then(|_| {
        file.sync_all()
            .map_err(|error| format!("Could not finish writing {}: {error}", partial.display()))
    })
    .and_then(|_| {
        fs::rename(&partial, destination)
            .map_err(|error| format!("Could not save {}: {error}", destination.display()))
    });

    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result.map(|_| destination.to_string_lossy().to_string())
}

/// Runs a registered transfer to the end and records how it went.
fn run_stream_transfer(
    app: tauri::AppHandle,
    uid: String,
    kind: &'static str,
    recording: Value,
    destination: Option<PathBuf>,
    cancel: Arc<AtomicBool>,
) {
    let state = app.state::<AppState>();
    let outcome =
        load_settings_from_state(&state).and_then(|settings| match (kind, destination.as_ref()) {
            ("archive", _) => {
                archive_stream_recording_inner(&app, &settings, &uid, &recording, &cancel)
            }
            (_, Some(destination)) => {
                download_stream_recording_inner(&app, &settings, &uid, destination, &cancel)
            }
            _ => Err("No destination was chosen.".to_string()),
        });

    let title = trim_string(recording.get("name")).unwrap_or_else(|| uid.clone());
    match outcome {
        Ok(destination) => {
            patch_stream_transfer(
                &app,
                &uid,
                json!({ "status": "done", "destination": destination, "message": Value::Null, "finishedAt": now_iso() }),
            );
            let _ = append_log(
                &state,
                "info",
                "stream-library",
                if kind == "archive" {
                    format!("Archived {title} to Backblaze.")
                } else {
                    format!("Saved {title} to {destination}.")
                },
                None,
            );
        }
        Err(error) if error == STREAM_TRANSFER_CANCELED => {
            patch_stream_transfer(
                &app,
                &uid,
                json!({ "status": "canceled", "message": Value::Null, "finishedAt": now_iso() }),
            );
        }
        Err(error) => {
            patch_stream_transfer(
                &app,
                &uid,
                json!({ "status": "failed", "errorMessage": error.clone(), "message": Value::Null, "finishedAt": now_iso() }),
            );
            let _ = append_log(
                &state,
                "error",
                "stream-library",
                format!("{title}: {error}"),
                None,
            );
        }
    }

    if let Ok(mut cancels) = state.stream_transfer_cancels.lock() {
        cancels.remove(&uid);
    };
}

fn run_rclone_capture(args: &[String]) -> Result<String, String> {
    let rclone_path = resolve_tool("rclone", &["version"]);
    let output = Command::new(&rclone_path)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Could not start rclone at {}: {error}",
                rclone_path.display()
            )
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn require_stream_library(settings: &Value) -> Result<(), String> {
    if !convex_is_configured(settings) {
        return Err("Connect the library in Settings to see Stream recordings.".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn list_stream_recordings(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    require_stream_library(&settings)?;

    let mut args = serde_json::Map::new();
    insert_if_present(
        &mut args,
        "before",
        trim_string(request.get("before")).map(Value::from),
    );
    insert_if_present(
        &mut args,
        "search",
        trim_string(request.get("search")).map(Value::from),
    );
    args.insert(
        "liveOnly".to_string(),
        Value::Bool(
            request
                .get("liveOnly")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
    );

    call_convex_action(&settings, STREAM_LIBRARY_LIST_ACTION, Value::Object(args))
        .await
        .map_err(|error| plain_handoff_error(&error))
}

/// Which Stream recordings already have a copy in the Backblaze archive.
#[tauri::command]
async fn list_archived_stream_uids(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let settings = load_settings_from_state(&state)?;
    if string_setting(&settings, &["b2", "bucket"])
        .trim()
        .is_empty()
    {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let bucket = string_setting(&settings, &["b2", "bucket"])
            .trim()
            .to_string();
        let listing = with_rclone_config(&settings, |config_path| {
            match run_rclone_capture(&[
                "lsjson".to_string(),
                remote_target("csnb2", &bucket, MASTERS_PREFIX),
                "--config".to_string(),
                config_path.to_string_lossy().to_string(),
                "--recursive".to_string(),
                "--files-only".to_string(),
            ]) {
                Ok(listing) => Ok(listing),
                Err(error) if is_missing_remote_error(&error) => Ok("[]".to_string()),
                Err(error) => Err(format!("Could not read the archive: {error}")),
            }
        })?;
        let parsed = serde_json::from_str::<Value>(&listing)
            .map_err(|error| format!("Could not read the archive listing: {error}"))?;
        Ok(archived_stream_uids(&parsed))
    })
    .await
    .map_err(|error| format!("Could not read the archive: {error}"))?
}

#[tauri::command]
async fn archive_stream_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    require_stream_library(&settings)?;
    if string_setting(&settings, &["b2", "bucket"])
        .trim()
        .is_empty()
    {
        return Err("Set up Backblaze in Settings before archiving recordings.".to_string());
    }

    let (uid, recording) = stream_recording_request(&request)?;
    let keys = stream_archive_keys(
        &uid,
        trim_string(recording.get("name")).as_deref(),
        trim_string(recording.get("clientName")).as_deref(),
        trim_string(recording.get("createdAt")).as_deref(),
    );
    let (snapshot, cancel) =
        begin_stream_transfer(&state, &uid, "archive", &recording, &keys.video)?;
    emit_stream_transfers(&app);

    let worker = app.clone();
    thread::spawn(move || run_stream_transfer(worker, uid, "archive", recording, None, cancel));
    Ok(snapshot)
}

#[tauri::command]
async fn download_stream_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    require_stream_library(&settings)?;
    let (uid, recording) = stream_recording_request(&request)?;

    let suggested = format!(
        "{}.mp4",
        sanitize_file_name(
            &trim_string(recording.get("name")).unwrap_or_else(|| uid.clone()),
            &uid,
        )
        .trim_end_matches(".mp4")
    );
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Save Recording")
        .set_file_name(&suggested)
        .add_filter("MP4 Video", &["mp4"])
        .blocking_save_file()
    else {
        return Ok(Value::Null);
    };
    let destination = PathBuf::from(pick_path_to_string(picked)?);

    let (snapshot, cancel) = begin_stream_transfer(
        &state,
        &uid,
        "download",
        &recording,
        &destination.to_string_lossy(),
    )?;
    emit_stream_transfers(&app);

    let worker = app.clone();
    thread::spawn(move || {
        run_stream_transfer(
            worker,
            uid,
            "download",
            recording,
            Some(destination),
            cancel,
        )
    });
    Ok(snapshot)
}

#[tauri::command]
fn cancel_stream_transfer(state: tauri::State<'_, AppState>, uid: String) -> Result<(), String> {
    if let Some(cancel) = state
        .stream_transfer_cancels
        .lock()
        .map_err(|_| "Transfers lock is unavailable.".to_string())?
        .get(uid.trim())
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
fn list_stream_transfers(state: tauri::State<'_, AppState>) -> Result<Vec<Value>, String> {
    state
        .stream_transfers
        .lock()
        .map(|transfers| transfers.clone())
        .map_err(|_| "Transfers lock is unavailable.".to_string())
}

/// Clears a finished transfer from the list. An active one is left alone.
#[tauri::command]
fn dismiss_stream_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    uid: String,
) -> Result<(), String> {
    state
        .stream_transfers
        .lock()
        .map_err(|_| "Transfers lock is unavailable.".to_string())?
        .retain(|transfer| {
            transfer.get("uid").and_then(Value::as_str) != Some(uid.trim())
                || stream_transfer_is_active(transfer)
        });
    emit_stream_transfers(&app);
    Ok(())
}

/* ------------------------------------------------------------------ offload */

/// Copying a camera card is the one long job in this app that an operator
/// stands over, so it has to be interruptible and, above all, resumable: a
/// 186 GB card that loses its connection two thirds of the way through must
/// pick up where it left off rather than start again.
///
/// That is what the manifest beside the package is for. Every file records how
/// it was verified — metadata in fast mode, SHA-256 in safe mode — so a resumed
/// run can tell "already copied correctly" from "looks about right". Nothing is
/// ever removed from the card.
const OFFLOAD_UPDATED_EVENT: &str = "media-bridge:offload-updated";
const OFFLOAD_MANIFEST_FILENAME: &str = "offload-manifest.json";
const OFFLOAD_LOG_FILENAME: &str = "offload.log";
const OFFLOAD_MANIFEST_VERSION: u64 = 3;
const WEBP_QUALITY: &str = "82";
/// Two file systems rarely agree on a modification time to the millisecond.
const LOCAL_COPY_MTIME_TOLERANCE_MS: i64 = 2000;

const OFFLOAD_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg"];
const OFFLOAD_VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "m4v", "webm"];
/// Directories the camera or the operating system made, not the shoot.
const VOLUME_METADATA_DIRECTORIES: &[&str] = &[
    ".spotlight-v100",
    ".fseventsd",
    ".trashes",
    ".temporaryitems",
    ".documentrevisions-v100",
    "system volume information",
    "$recycle.bin",
    ".ds_store",
];

struct OffloadFile {
    absolute_path: PathBuf,
    relative_path: String,
    size: u64,
    kind: &'static str,
    mtime_ms: i64,
}

fn offload_file_kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if OFFLOAD_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        "image"
    } else if OFFLOAD_VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        "video"
    } else {
        "other"
    }
}

fn system_time_to_ms(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn collect_offload_files(root: &Path, current: &Path, files: &mut Vec<OffloadFile>) {
    // A card with an unreadable corner should still offload the rest of itself,
    // so a directory we cannot read is skipped rather than fatal.
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };

    let mut sorted_entries = entries.flatten().collect::<Vec<_>>();
    sorted_entries.sort_by_key(|entry| entry.file_name());

    for entry in sorted_entries {
        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().to_ascii_lowercase();

        if entry_path.is_dir() {
            if VOLUME_METADATA_DIRECTORIES.contains(&entry_name.as_str()) {
                continue;
            }
            collect_offload_files(root, &entry_path, files);
            continue;
        }

        if !entry_path.is_file() {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(relative_path) = entry_path.strip_prefix(root) else {
            continue;
        };

        files.push(OffloadFile {
            relative_path: relative_path.to_string_lossy().to_string(),
            size: metadata.len(),
            kind: offload_file_kind(&entry_path),
            mtime_ms: metadata.modified().map(system_time_to_ms).unwrap_or(0),
            absolute_path: entry_path,
        });
    }
}

fn to_webp_relative_path(relative_path: &str) -> String {
    let lowered = relative_path.to_ascii_lowercase();
    for extension in OFFLOAD_IMAGE_EXTENSIONS {
        let suffix = format!(".{extension}");
        if lowered.ends_with(&suffix) {
            return format!(
                "{}.webp",
                &relative_path[..relative_path.len() - suffix.len()]
            );
        }
    }
    format!("{relative_path}.webp")
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex_encode(&hasher.finalize()))
}

/// Copies a file and carries its modification time across, so a later fast-mode
/// run can recognise the copy as already done.
fn copy_preserving_mtime(source: &Path, destination: &Path, mtime_ms: i64) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    fs::copy(source, destination).map_err(|error| {
        format!(
            "Could not copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;

    if mtime_ms > 0 {
        let modified = SystemTime::UNIX_EPOCH + Duration::from_millis(mtime_ms as u64);
        if let Ok(file) = fs::File::options().write(true).open(destination) {
            let _ = file.set_times(fs::FileTimes::new().set_modified(modified));
        }
    }

    Ok(())
}

fn file_matches_metadata(path: &Path, size: u64, mtime_ms: i64) -> bool {
    fs::metadata(path)
        .map(|metadata| {
            metadata.is_file()
                && metadata.len() == size
                && (metadata.modified().map(system_time_to_ms).unwrap_or(0) - mtime_ms).abs()
                    <= LOCAL_COPY_MTIME_TOLERANCE_MS
        })
        .unwrap_or(false)
}

fn file_matches_checksum(path: &Path, checksum: &str, size: Option<u64>) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if let Some(size) = size {
        if metadata.len() != size {
            return false;
        }
    }

    file_sha256(path)
        .map(|actual| actual == checksum)
        .unwrap_or(false)
}

fn convert_image_to_webp(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let _ = fs::remove_file(destination);

    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-c:v".to_string(),
        "libwebp".to_string(),
        "-quality".to_string(),
        WEBP_QUALITY.to_string(),
        "-compression_level".to_string(),
        "6".to_string(),
        "-preset".to_string(),
        "picture".to_string(),
        "-pix_fmt".to_string(),
        "yuva420p".to_string(),
        destination.to_string_lossy().to_string(),
    ])
}

fn build_offload_folder_name(job_name: &str) -> String {
    let slug = slugify_segment(Some(job_name), "offload");
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    format!("{timestamp}-{slug}")
}

/// Looks for a package in the destination root that was made from this same
/// card under this same name. Finding one is what makes a run a resume.
fn find_existing_offload_manifest(
    destination_root: &Path,
    source_path: &str,
    job_name: &str,
) -> Option<Value> {
    let entries = fs::read_dir(destination_root).ok()?;

    for entry in entries.flatten() {
        let manifest_path = entry.path().join(OFFLOAD_MANIFEST_FILENAME);
        if !manifest_path.is_file() {
            continue;
        }

        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };

        if manifest.get("sourcePath").and_then(Value::as_str) == Some(source_path)
            && manifest.get("jobName").and_then(Value::as_str) == Some(job_name)
        {
            return Some(manifest);
        }
    }

    None
}

/// Copy dominates the clock, so it dominates the bar; the other two phases only
/// take a share of it when they are actually going to run.
fn offload_stage_weights(convert_images: bool, upload_images: bool) -> (f64, f64, f64) {
    match (convert_images, upload_images) {
        (true, true) => (60.0, 20.0, 20.0),
        (true, false) => (75.0, 25.0, 0.0),
        (false, true) => (75.0, 0.0, 25.0),
        (false, false) => (100.0, 0.0, 0.0),
    }
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

struct OffloadRun {
    app: tauri::AppHandle,
    manifest: Value,
    snapshot: Value,
    log_path: PathBuf,
    manifest_path: PathBuf,
    weights: (f64, f64, f64),
}

impl OffloadRun {
    fn patch_snapshot(&mut self, patch: Value) {
        if let (Some(snapshot), Some(patch)) = (self.snapshot.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                snapshot.insert(key.clone(), value.clone());
            }
        }

        let copy_progress = value_to_f64(self.snapshot.get("copyProgress")).unwrap_or(0.0);
        let conversion_progress =
            value_to_f64(self.snapshot.get("conversionProgress")).unwrap_or(0.0);
        let upload_progress = value_to_f64(self.snapshot.get("uploadProgress")).unwrap_or(0.0);
        let overall = if self.snapshot.get("status").and_then(Value::as_str) == Some("complete") {
            100.0
        } else {
            clamp_percent(
                (copy_progress * self.weights.0
                    + conversion_progress * self.weights.1
                    + upload_progress * self.weights.2)
                    / 100.0,
            )
        };

        if let Some(snapshot) = self.snapshot.as_object_mut() {
            snapshot.insert("overallProgress".to_string(), json!(overall));
        }

        // The manifest mirrors the snapshot so a resumed run starts where this
        // one stopped, even if the app was killed rather than closed.
        if let Some(manifest) = self.manifest.as_object_mut() {
            for key in [
                "status",
                "message",
                "completedAt",
                "errorMessage",
                "copyProgress",
                "conversionProgress",
                "uploadProgress",
                "overallProgress",
                "skippedFiles",
            ] {
                if let Some(value) = self.snapshot.get(key) {
                    manifest.insert(key.to_string(), value.clone());
                }
            }
            manifest.insert("updatedAt".to_string(), json!(now_iso()));
        }

        let _ = fs::write(
            &self.manifest_path,
            serde_json::to_string_pretty(&self.manifest).unwrap_or_default(),
        );

        let state = self.app.state::<AppState>();
        if let Ok(mut task) = state.offload_task.lock() {
            *task = Some(self.snapshot.clone());
        }
        let _ = self.app.emit(OFFLOAD_UPDATED_EVENT, self.snapshot.clone());
    }

    fn log(&self, message: &str) {
        let line = format!(
            "[{}] {message}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        if let Ok(mut file) = fs::File::options()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = file.write_all(line.as_bytes());
        }

        let state = self.app.state::<AppState>();
        let _ = append_log(&state, "info", "offload", message.to_string(), None);
    }
}

/// Pause and cancel are checked between files rather than mid-file: a partially
/// written file is the one thing a resumable copy cannot reason about.
fn offload_interruption(state: &tauri::State<'_, AppState>) -> Option<&'static str> {
    if state.offload_cancel.load(Ordering::SeqCst) {
        Some("canceled")
    } else if state.offload_pause.load(Ordering::SeqCst) {
        Some("paused")
    } else {
        None
    }
}

/// The offload itself, on a worker thread: copy, convert, upload.
///
/// Every phase is skippable and every phase is resumable. Nothing here deletes
/// anything from the card — the source is only ever read.
fn run_offload(app: tauri::AppHandle, request: Value, settings: Value) {
    let state = app.state::<AppState>();

    let outcome = (|| -> Result<(), String> {
        let source_path = trim_string(request.get("sourcePath"))
            .ok_or_else(|| "Choose a card or folder to copy from.".to_string())?;
        let source_root = PathBuf::from(&source_path);
        if !source_root.is_dir() {
            return Err(format!("Could not read {}.", source_root.display()));
        }

        let convert_images = request
            .get("convertImagesToWebp")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let upload_images = request
            .get("uploadToB2")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let source_name = file_name(&source_root);
        let job_name = trim_string(request.get("jobName")).unwrap_or_else(|| source_name.clone());

        let destination_root =
            PathBuf::from(string_setting(&settings, &["offload", "localFolder"]).trim());
        if destination_root.as_os_str().is_empty() {
            return Err("Set an offload drive in Settings before copying a card.".to_string());
        }
        fs::create_dir_all(&destination_root)
            .map_err(|error| format!("Could not create {}: {error}", destination_root.display()))?;

        let existing_manifest =
            find_existing_offload_manifest(&destination_root, &source_path, &job_name);
        let folder_name = existing_manifest
            .as_ref()
            .and_then(|manifest| trim_string(manifest.get("folderName")))
            .unwrap_or_else(|| build_offload_folder_name(&job_name));
        let package_path = destination_root.join(&folder_name);
        let web_ready_path = package_path.join("web-ready");
        let manifest_path = package_path.join(OFFLOAD_MANIFEST_FILENAME);
        let log_path = package_path.join(OFFLOAD_LOG_FILENAME);
        let cloud_object_key = join_object_key(&[
            Some(string_setting(&settings, &["offload", "b2PathPrefix"]).to_string()),
            Some(folder_name.clone()),
        ]);

        // Copying a folder into itself would walk forever.
        if package_path.starts_with(&source_root) {
            return Err("The offload drive cannot be inside the card you are copying.".to_string());
        }

        fs::create_dir_all(&package_path)
            .map_err(|error| format!("Could not create {}: {error}", package_path.display()))?;
        if convert_images {
            fs::create_dir_all(&web_ready_path).map_err(|error| {
                format!("Could not create {}: {error}", web_ready_path.display())
            })?;
        }

        let mut files = Vec::new();
        collect_offload_files(&source_root, &source_root, &mut files);
        let total_files = files.len() as u64;
        let total_bytes: u64 = files.iter().map(|file| file.size).sum();
        let image_files = files
            .iter()
            .filter(|file| file.kind == "image")
            .collect::<Vec<_>>();
        let image_count = image_files.len() as u64;

        let is_resume = existing_manifest.is_some();
        let mut manifest = existing_manifest.unwrap_or_else(|| {
            json!({
                "version": OFFLOAD_MANIFEST_VERSION,
                "taskId": create_id("offload", 1),
                "sourcePath": source_path,
                "sourceName": source_name,
                "jobName": job_name,
                "folderName": folder_name,
                "localDestinationPath": package_path.to_string_lossy(),
                "webReadyPath": web_ready_path.to_string_lossy(),
                "manifestPath": manifest_path.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
                "cloudObjectKey": cloud_object_key,
                "createdAt": now_iso(),
                "startedAt": now_iso(),
                "entries": {},
            })
        });

        if let Some(manifest) = manifest.as_object_mut() {
            manifest.insert("convertImagesToWebp".to_string(), json!(convert_images));
            manifest.insert("uploadToB2".to_string(), json!(upload_images));
            manifest.insert("startedAt".to_string(), json!(now_iso()));
            manifest.insert("completedAt".to_string(), Value::Null);
            manifest.insert("errorMessage".to_string(), Value::Null);
            manifest
                .entry("entries".to_string())
                .or_insert_with(|| json!({}));
        }

        let task_id =
            trim_string(manifest.get("taskId")).unwrap_or_else(|| create_id("offload", 1));

        let snapshot = json!({
            "id": task_id,
            "status": "preparing",
            "message": "Preparing the offload package.",
            "sourcePath": source_path,
            "sourceName": source_name,
            "jobName": job_name,
            "localDestinationPath": package_path.to_string_lossy(),
            "webReadyPath": if convert_images { json!(web_ready_path.to_string_lossy()) } else { Value::Null },
            "cloudObjectKey": if upload_images { json!(cloud_object_key) } else { Value::Null },
            "manifestPath": manifest_path.to_string_lossy(),
            "logPath": log_path.to_string_lossy(),
            "copyProgress": 0,
            "conversionProgress": 0,
            "uploadProgress": 0,
            "overallProgress": 0,
            "totalFiles": total_files,
            "imageCount": image_count,
            "copiedFiles": 0,
            "totalBytes": total_bytes,
            "copiedBytes": 0,
            "convertedImageCount": 0,
            "skippedFiles": 0,
            "uploadEnabled": upload_images,
            "startedAt": now_iso(),
            "completedAt": Value::Null,
            "errorMessage": Value::Null,
        });

        let mut run = OffloadRun {
            app: app.clone(),
            manifest,
            snapshot,
            log_path,
            manifest_path,
            weights: offload_stage_weights(convert_images, upload_images),
        };

        run.log(&if is_resume {
            format!(
                "Resuming the copy of {source_name} into {}.",
                package_path.display()
            )
        } else {
            format!("Copying {source_name} into {}.", package_path.display())
        });

        let copy_mode = string_setting(&settings, &["offload", "localCopyMode"]).to_string();
        let safe_mode = copy_mode == "safe";

        run.patch_snapshot(json!({
            "status": "copying",
            "message": if safe_mode {
                "Copying and checking every file against its checksum."
            } else {
                "Copying video and photos."
            },
        }));

        let mut copied_files = 0_u64;
        let mut copied_bytes = 0_u64;
        let mut skipped_files = 0_u64;

        for file in &files {
            if let Some(interruption) = offload_interruption(&state) {
                return Err(format!("__interrupted__{interruption}"));
            }

            let destination = package_path.join(&file.relative_path);
            let entry_checksum = run
                .manifest
                .get("entries")
                .and_then(|entries| entries.get(&file.relative_path))
                .and_then(|entry| entry.get("localChecksum"))
                .and_then(Value::as_str)
                .map(str::to_string);

            let already_there = if safe_mode {
                match entry_checksum.as_deref() {
                    Some(checksum) => {
                        file_matches_checksum(&destination, checksum, Some(file.size))
                    }
                    None => false,
                }
            } else {
                file_matches_metadata(&destination, file.size, file.mtime_ms)
            };

            let checksum = if already_there {
                skipped_files += 1;
                entry_checksum
            } else {
                copy_preserving_mtime(&file.absolute_path, &destination, file.mtime_ms)?;

                if safe_mode {
                    let source_checksum = file_sha256(&file.absolute_path)?;
                    let destination_checksum = file_sha256(&destination)?;
                    if source_checksum != destination_checksum {
                        return Err(format!(
                            "{} did not copy cleanly — the copy does not match the original.",
                            file.relative_path
                        ));
                    }
                    Some(destination_checksum)
                } else {
                    if !file_matches_metadata(&destination, file.size, file.mtime_ms) {
                        return Err(format!(
                            "{} did not copy cleanly — the copy does not match the original.",
                            file.relative_path
                        ));
                    }
                    None
                }
            };

            if let Some(entries) = run
                .manifest
                .get_mut("entries")
                .and_then(Value::as_object_mut)
            {
                entries.insert(
                    file.relative_path.clone(),
                    json!({
                        "size": file.size,
                        "kind": file.kind,
                        "localStatus": "verified",
                        "localChecksum": checksum,
                        "localCopiedAt": now_iso(),
                        "webpRelativePath": to_webp_relative_path(&file.relative_path),
                    }),
                );
            }

            copied_files += 1;
            copied_bytes += file.size;

            run.patch_snapshot(json!({
                "copiedFiles": copied_files,
                "copiedBytes": copied_bytes,
                "skippedFiles": skipped_files,
                "copyProgress": if total_bytes > 0 {
                    clamp_percent(copied_bytes as f64 / total_bytes as f64 * 100.0)
                } else if total_files > 0 {
                    clamp_percent(copied_files as f64 / total_files as f64 * 100.0)
                } else {
                    100.0
                },
                "message": format!("Copied {}.", file.relative_path),
            }));
        }

        run.patch_snapshot(json!({ "copyProgress": 100.0 }));
        run.log(&format!(
            "Copied {copied_files} files ({skipped_files} already there)."
        ));

        if convert_images {
            run.patch_snapshot(json!({
                "status": "converting",
                "message": if image_count == 0 {
                    "No photos to make web-friendly copies of.".to_string()
                } else {
                    "Making web-friendly photo copies.".to_string()
                },
                "conversionProgress": if image_count == 0 { 100.0 } else { 0.0 },
            }));

            let mut converted = 0_u64;
            for file in &image_files {
                if let Some(interruption) = offload_interruption(&state) {
                    return Err(format!("__interrupted__{interruption}"));
                }

                let relative_output = to_webp_relative_path(&file.relative_path);
                let output_path = web_ready_path.join(&relative_output);
                let existing_checksum = run
                    .manifest
                    .get("entries")
                    .and_then(|entries| entries.get(&file.relative_path))
                    .and_then(|entry| entry.get("webpChecksum"))
                    .and_then(Value::as_str)
                    .map(str::to_string);

                let already_converted = match existing_checksum.as_deref() {
                    Some(checksum) => file_matches_checksum(&output_path, checksum, None),
                    None => false,
                };

                if already_converted {
                    skipped_files += 1;
                } else {
                    convert_image_to_webp(&file.absolute_path, &output_path)?;
                    let checksum = file_sha256(&output_path)?;
                    let size = fs::metadata(&output_path)
                        .map(|meta| meta.len())
                        .unwrap_or(0);

                    if let Some(entry) = run
                        .manifest
                        .get_mut("entries")
                        .and_then(Value::as_object_mut)
                        .and_then(|entries| entries.get_mut(&file.relative_path))
                        .and_then(Value::as_object_mut)
                    {
                        entry.insert("webpRelativePath".to_string(), json!(relative_output));
                        entry.insert("webpStatus".to_string(), json!("verified"));
                        entry.insert("webpChecksum".to_string(), json!(checksum));
                        entry.insert("webpSize".to_string(), json!(size));
                        entry.insert("webpCreatedAt".to_string(), json!(now_iso()));
                    }
                }

                converted += 1;
                run.patch_snapshot(json!({
                    "convertedImageCount": converted,
                    "skippedFiles": skipped_files,
                    "conversionProgress": clamp_percent(converted as f64 / image_count.max(1) as f64 * 100.0),
                    "message": format!("Made a web-friendly copy of {}.", file.relative_path),
                }));
            }

            run.patch_snapshot(json!({ "conversionProgress": 100.0 }));
        }

        if upload_images {
            if let Some(interruption) = offload_interruption(&state) {
                return Err(format!("__interrupted__{interruption}"));
            }

            if image_files.is_empty() {
                run.log("No photos to send to the cloud. Video always stays on the drive.");
                run.patch_snapshot(json!({
                    "status": "uploading",
                    "uploadProgress": 100.0,
                    "message": "No photos to send. Video stays on the drive.",
                }));
            } else {
                run.patch_snapshot(json!({
                    "status": "uploading",
                    "message": "Sending photos to the cloud.",
                }));

                // Only the photos go up, so they are staged into their own
                // directory rather than uploading the package wholesale —
                // video always stays on the offload drive.
                let staging_directory =
                    std::env::temp_dir().join(create_id("csn-media-bridge-offload-images", 1));
                let staged = (|| -> Result<(), String> {
                    for file in &image_files {
                        let staged_path = staging_directory.join(&file.relative_path);
                        copy_preserving_mtime(
                            &package_path.join(&file.relative_path),
                            &staged_path,
                            file.mtime_ms,
                        )?;

                        if convert_images {
                            let relative_output = to_webp_relative_path(&file.relative_path);
                            let source = web_ready_path.join(&relative_output);
                            if source.is_file() {
                                copy_preserving_mtime(
                                    &source,
                                    &staging_directory.join("web-ready").join(&relative_output),
                                    file.mtime_ms,
                                )?;
                            }
                        }
                    }

                    let upload_concurrency =
                        number_setting(&settings, &["uploadConcurrency"], 10.0) as u64;
                    let bucket = string_setting(&settings, &["b2", "bucket"]).to_string();

                    with_rclone_config(&settings, |config_path| {
                        copy_to_rclone(
                            &staging_directory,
                            "csnb2",
                            &bucket,
                            &cloud_object_key,
                            config_path,
                            true,
                            upload_concurrency,
                        )
                    })
                })();

                let _ = fs::remove_dir_all(&staging_directory);
                staged?;

                run.log("Photos reached the cloud.");
                run.patch_snapshot(json!({
                    "uploadProgress": 100.0,
                    "message": "Photos are in the cloud.",
                }));
            }
        }

        run.log(&format!("Finished copying {source_name}."));
        run.patch_snapshot(json!({
            "status": "complete",
            "message": if upload_images {
                "Finished. Video stayed on the drive; photos went to the cloud."
            } else {
                "Finished. Everything is on the offload drive."
            },
            "copyProgress": 100.0,
            "skippedFiles": skipped_files,
            "completedAt": now_iso(),
            "errorMessage": Value::Null,
        }));

        Ok(())
    })();

    if let Err(error) = outcome {
        // Pause and cancel travel as errors so every phase can unwind the same
        // way, but neither is a failure and neither should read as one.
        let (status, message) = if let Some(kind) = error.strip_prefix("__interrupted__") {
            if kind == "canceled" {
                (
                    "canceled",
                    "Stopped — what copied so far is kept, and nothing was removed from the card."
                        .to_string(),
                )
            } else {
                (
                    "paused",
                    "Paused — resume whenever you like and it picks up from here.".to_string(),
                )
            }
        } else {
            ("error", error)
        };

        let snapshot = {
            let mut task = state.offload_task.lock().ok();
            let existing = task
                .as_mut()
                .and_then(|task| task.clone())
                .unwrap_or_else(|| json!({}));
            let mut snapshot = existing.as_object().cloned().unwrap_or_default();
            snapshot.insert("status".to_string(), json!(status));
            snapshot.insert("message".to_string(), json!(message.clone()));
            snapshot.insert(
                "errorMessage".to_string(),
                if status == "error" {
                    json!(message)
                } else {
                    Value::Null
                },
            );
            if status != "paused" {
                snapshot.insert("completedAt".to_string(), json!(now_iso()));
            }
            let snapshot = Value::Object(snapshot);
            if let Some(task) = task.as_mut() {
                **task = Some(snapshot.clone());
            }
            snapshot
        };

        let _ = append_log(
            &state,
            if status == "error" { "error" } else { "info" },
            "offload",
            message,
            None,
        );
        let _ = app.emit(OFFLOAD_UPDATED_EVENT, snapshot);
    }

    state.offload_running.store(false, Ordering::SeqCst);
    state.offload_pause.store(false, Ordering::SeqCst);
    state.offload_cancel.store(false, Ordering::SeqCst);
}

/* ------------------------------------------------------------- upload audit */

/// Comparing what should be in the cloud against what is actually there.
///
/// An interrupted upload is the failure this app sees most, and the damage is
/// invisible: a playback package missing three segments plays fine until the
/// viewer reaches them. The audit lists both sides and names the difference so
/// "it uploaded" can be checked rather than assumed.
fn rclone_list_remote_objects(
    settings: &Value,
    remote_name: &str,
    bucket: &str,
    remote_prefix: &str,
    recursive: bool,
) -> Result<Vec<Value>, String> {
    let normalized_prefix = remote_prefix.trim_matches('/').to_string();
    if normalized_prefix.is_empty() {
        return Ok(Vec::new());
    }

    let listing = with_rclone_config(settings, |config_path| {
        let mut args = vec![
            "lsjson".to_string(),
            remote_target(remote_name, bucket, &normalized_prefix),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
            "--files-only".to_string(),
        ];
        if recursive {
            args.push("--recursive".to_string());
        }

        let rclone_path = resolve_tool("rclone", &["version"]);
        let output = Command::new(&rclone_path)
            .args(&args)
            .output()
            .map_err(|error| {
                format!(
                    "Could not start rclone at {}: {error}",
                    rclone_path.display()
                )
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            // A prefix that was never written lists as nothing, not as an error.
            if is_missing_remote_error(&stderr) {
                return Ok(String::from("[]"));
            }
            return Err(stderr);
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })?;

    let entries = serde_json::from_str::<Value>(&listing)
        .map_err(|error| format!("Could not read the remote listing: {error}"))?;

    Ok(entries
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    let relative_path = entry
                        .get("Path")
                        .and_then(Value::as_str)
                        .or_else(|| entry.get("Name").and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_string();
                    json!({
                        "objectKey": join_object_key(&[
                            Some(normalized_prefix.clone()),
                            Some(relative_path.clone()),
                        ]),
                        "relativePath": relative_path,
                        "sizeBytes": entry.get("Size").and_then(Value::as_i64).unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

/// Every file the local output directory says should have gone up.
fn collect_local_directory_objects(
    local_directory: &Path,
    current: &Path,
    remote_prefix: &str,
    objects: &mut Vec<Value>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            collect_local_directory_objects(local_directory, &entry_path, remote_prefix, objects);
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(relative_path) = entry_path.strip_prefix(local_directory) else {
            continue;
        };
        let relative_path = relative_path.to_string_lossy().replace('\\', "/");

        objects.push(json!({
            "objectKey": join_object_key(&[
                Some(remote_prefix.to_string()),
                Some(relative_path.clone()),
            ]),
            "relativePath": relative_path,
            "sizeBytes": metadata.len(),
        }));
    }
}

fn object_key_of(object: &Value) -> String {
    object
        .get("objectKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn build_upload_audit_section(
    label: &str,
    storage: &str,
    bucket: &str,
    remote_prefix: &str,
    local_path: Option<&str>,
    local_exists: bool,
    expected_objects: Vec<Value>,
    remote_objects: Vec<Value>,
) -> Value {
    let expected_keys = expected_objects
        .iter()
        .map(object_key_of)
        .collect::<Vec<_>>();
    let remote_keys = remote_objects.iter().map(object_key_of).collect::<Vec<_>>();

    let missing_object_keys = expected_keys
        .iter()
        .filter(|key| !remote_keys.contains(key))
        .cloned()
        .collect::<Vec<_>>();
    let unexpected_object_keys = remote_keys
        .iter()
        .filter(|key| !expected_keys.contains(key))
        .cloned()
        .collect::<Vec<_>>();
    let size_mismatch_object_keys = expected_objects
        .iter()
        .filter_map(|expected| {
            let key = object_key_of(expected);
            let expected_size = expected.get("sizeBytes").and_then(Value::as_i64)?;
            let remote = remote_objects
                .iter()
                .find(|remote| object_key_of(remote) == key)?;
            let remote_size = remote.get("sizeBytes").and_then(Value::as_i64)?;
            (remote_size != expected_size).then_some(key)
        })
        .collect::<Vec<_>>();

    let mut sorted_remote_objects = remote_objects;
    sorted_remote_objects.sort_by_key(object_key_of);

    json!({
        "label": label,
        "storage": storage,
        "bucket": bucket,
        "remotePrefix": remote_prefix,
        "localPath": local_path,
        "localExists": local_exists,
        "expectedObjects": expected_objects,
        "remoteObjects": sorted_remote_objects,
        "missingObjectKeys": missing_object_keys,
        "unexpectedObjectKeys": unexpected_object_keys,
        "sizeMismatchObjectKeys": size_mismatch_object_keys,
    })
}

fn section_len(section: &Value, key: &str) -> usize {
    section
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

/// One word for the whole audit, chosen so that "healthy" is only ever claimed
/// when there was something local to compare against.
fn summarize_upload_audit(source_name: &str, sections: &[&Value]) -> (String, String) {
    let issue_count: usize = sections
        .iter()
        .map(|section| {
            section_len(section, "missingObjectKeys")
                + section_len(section, "unexpectedObjectKeys")
                + section_len(section, "sizeMismatchObjectKeys")
        })
        .sum();

    let has_no_remote_objects = sections
        .iter()
        .all(|section| section_len(section, "remoteObjects") == 0);
    let has_expected_objects = sections
        .iter()
        .any(|section| section_len(section, "expectedObjects") > 0);
    let local_comparison_unavailable = sections.iter().any(|section| {
        !section
            .get("localExists")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || section_len(section, "expectedObjects") == 0
    });

    if issue_count == 0 && has_expected_objects && !local_comparison_unavailable {
        return (
            "healthy".to_string(),
            format!("Everything for {source_name} reached the cloud intact."),
        );
    }

    if has_no_remote_objects && has_expected_objects {
        return (
            "missing".to_string(),
            format!("Nothing for {source_name} reached the cloud."),
        );
    }

    if issue_count > 0 {
        return (
            "partial".to_string(),
            format!(
                "Found {issue_count} difference{} between {source_name} and the cloud.",
                if issue_count == 1 { "" } else { "s" }
            ),
        );
    }

    (
        "unknown".to_string(),
        format!("The local files for {source_name} are gone, so there is nothing to compare the cloud against."),
    )
}

fn audit_job_uploads_inner(
    state: &tauri::State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    let settings = load_settings_from_state(state)?;
    let job = get_job(state, job_id)?;

    let archive_object_key = trim_string(job.get("archiveObjectKey"));
    let distribution_object_key = trim_string(job.get("distributionObjectKey"));

    if archive_object_key.is_none() && distribution_object_key.is_none() {
        return Err("This one has not reached the upload step yet.".to_string());
    }

    let source_name = trim_string(job.get("sourceName")).unwrap_or_default();
    let source_path = trim_string(job.get("sourcePath")).unwrap_or_default();
    let output_directory = trim_string(job.get("outputDirectory"));

    let archive_section = match archive_object_key.as_deref() {
        Some(archive_object_key) => {
            let source_metadata = fs::metadata(&source_path).ok();
            let source_exists = source_metadata
                .as_ref()
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            let base_name = archive_object_key.rsplit('/').next().unwrap_or_default();
            let parent_prefix = archive_object_key
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .unwrap_or_default();

            let expected_objects = if source_exists {
                vec![json!({
                    "objectKey": archive_object_key,
                    "relativePath": base_name,
                    "sizeBytes": source_metadata.as_ref().map(|metadata| metadata.len()).unwrap_or(0),
                })]
            } else {
                Vec::new()
            };

            // The archive is one object inside a shared folder, so the listing
            // is narrowed to that file rather than reporting its neighbours as
            // unexpected.
            let remote_objects = rclone_list_remote_objects(
                &settings,
                "csnb2",
                string_setting(&settings, &["b2", "bucket"]),
                &parent_prefix,
                false,
            )?
            .into_iter()
            .filter(|object| object_key_of(object).rsplit('/').next() == Some(base_name))
            .collect::<Vec<_>>();

            Some(build_upload_audit_section(
                "Archived original",
                "b2",
                string_setting(&settings, &["b2", "bucket"]),
                archive_object_key,
                Some(&source_path),
                source_exists,
                expected_objects,
                remote_objects,
            ))
        }
        None => None,
    };

    let distribution_section = match distribution_object_key.as_deref() {
        Some(distribution_object_key) => {
            let local_directory = output_directory.as_deref().map(PathBuf::from);
            let local_exists = local_directory
                .as_ref()
                .map(|path| path.is_dir())
                .unwrap_or(false);

            let mut expected_objects = Vec::new();
            if let Some(local_directory) = local_directory.as_ref().filter(|_| local_exists) {
                collect_local_directory_objects(
                    local_directory,
                    local_directory,
                    distribution_object_key,
                    &mut expected_objects,
                );
            }

            let remote_objects = rclone_list_remote_objects(
                &settings,
                "csnr2",
                string_setting(&settings, &["r2", "bucket"]),
                distribution_object_key,
                true,
            )?;

            Some(build_upload_audit_section(
                "Playback package",
                "r2",
                string_setting(&settings, &["r2", "bucket"]),
                distribution_object_key,
                output_directory.as_deref(),
                local_exists,
                expected_objects,
                remote_objects,
            ))
        }
        None => None,
    };

    let sections = [archive_section.as_ref(), distribution_section.as_ref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let (status, message) = summarize_upload_audit(&source_name, &sections);

    let can_resume_same_prefix = archive_object_key.is_some() || distribution_object_key.is_some();
    let can_cleanup_remote = sections
        .iter()
        .any(|section| section_len(section, "remoteObjects") > 0);

    Ok(json!({
        "jobId": job_id,
        "sourceName": source_name,
        "status": status,
        "message": message,
        "auditedAt": now_iso(),
        "canResumeSamePrefix": can_resume_same_prefix,
        "canCleanupRemote": can_cleanup_remote,
        "archive": archive_section,
        "distribution": distribution_section,
    }))
}

/* ----------------------------------------------------------------- watching */

/// The watch folder is the normal way a video gets into this app: an editor
/// exports into it and the rest happens on its own.
///
/// The one hard part is knowing when a file has finished arriving. A large
/// export is visible on disk long before it is complete, and starting on a
/// half-written file wastes an hour and produces a broken video. So a candidate
/// has to hold the same size and modification time across several passes, and
/// be openable for reading, before it is queued. That is what
/// `readyCheckStablePasses` and `readyCheckIntervalMs` are for.
fn scan_watch_folder(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };

    let mut candidates = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }

            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();

            SUPPORTED_INGEST_EXTENSIONS
                .contains(&extension.as_str())
                .then_some(path)
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates
}

/// True once the file has stopped changing and can be opened for reading.
fn wait_for_file_ready(path: &Path, settings: &Value, watching: &Arc<AtomicBool>) -> bool {
    let stable_passes_needed =
        number_setting(settings, &["readyCheckStablePasses"], 3.0).max(1.0) as u32;
    let interval_ms = number_setting(settings, &["readyCheckIntervalMs"], 2000.0).max(250.0) as u64;

    let mut stable_passes = 0_u32;
    let mut previous_signature = String::new();

    for _ in 0..180 {
        if !watching.load(Ordering::SeqCst) {
            return false;
        }

        if let Ok(metadata) = fs::metadata(path) {
            let signature = format!(
                "{}:{}",
                metadata.len(),
                metadata.modified().map(system_time_to_ms).unwrap_or(0)
            );

            // Being able to open it matters as much as the size holding still:
            // on Windows the exporter keeps an exclusive handle until it is done.
            if signature == previous_signature && metadata.len() > 0 && fs::File::open(path).is_ok()
            {
                stable_passes += 1;
            } else {
                stable_passes = 0;
                previous_signature = signature;
            }

            if stable_passes >= stable_passes_needed {
                return true;
            }
        }

        thread::sleep(Duration::from_millis(interval_ms));
    }

    false
}

fn watch_folder_loop(app: tauri::AppHandle, watching: Arc<AtomicBool>) {
    // Files seen in the first sweep are left alone: the folder's existing
    // contents are history, not an arrival.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut primed = false;

    while watching.load(Ordering::SeqCst) {
        let state = app.state::<AppState>();
        let Ok(settings) = load_settings_from_state(&state) else {
            thread::sleep(Duration::from_secs(2));
            continue;
        };

        let watch_folder = string_setting(&settings, &["watchFolder"])
            .trim()
            .to_string();
        if watch_folder.is_empty() {
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        let candidates = scan_watch_folder(Path::new(&watch_folder));

        if !primed {
            seen.extend(candidates.iter().cloned());
            primed = true;
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        for candidate in candidates {
            if !watching.load(Ordering::SeqCst) {
                return;
            }
            if seen.contains(&candidate) {
                continue;
            }
            seen.insert(candidate.clone());

            let _ = append_log(
                &state,
                "info",
                "watcher",
                format!(
                    "{} appeared. Waiting for it to finish copying.",
                    file_name(&candidate)
                ),
                None,
            );
            emit_state_update(&app);

            if !wait_for_file_ready(&candidate, &settings, &watching) {
                if watching.load(Ordering::SeqCst) {
                    let _ = append_log(
                        &state,
                        "warn",
                        "watcher",
                        format!(
                            "{} never stopped changing, so it was left alone.",
                            file_name(&candidate)
                        ),
                        None,
                    );
                    emit_state_update(&app);
                }
                continue;
            }

            let _ = append_log(
                &state,
                "info",
                "watcher",
                format!("{} finished copying. Queued.", file_name(&candidate)),
                None,
            );

            let request = json!({
                "sourcePath": candidate.to_string_lossy(),
                "route": "web_streaming",
            });

            match create_manual_job(&state, request) {
                Ok((_, Some(job_id))) => {
                    emit_state_update(&app);
                    let worker_app = app.clone();
                    thread::spawn(move || {
                        process_queued_job(worker_app, job_id);
                    });
                }
                Ok((_, None)) => emit_state_update(&app),
                Err(error) => {
                    let _ = append_log(
                        &state,
                        "error",
                        "watcher",
                        format!("Could not queue {}: {error}", file_name(&candidate)),
                        None,
                    );
                    emit_state_update(&app);
                }
            }
        }

        // A file removed from the folder can arrive again later.
        seen.retain(|path| path.exists());
        thread::sleep(Duration::from_secs(2));
    }
}

/* ----------------------------------------------------------------- updating */

/// In-app updates.
///
/// Tauri's updater verifies a minisign signature over every artifact before it
/// will install anything, which is what makes an unsigned macOS build safe to
/// ship this way: the bundle itself is not notarized, but the update path still
/// refuses anything this project did not sign.
///
/// The feed URL is an operator setting rather than a build-time constant, so a
/// station can be pointed at a different release host without a rebuild. That
/// is why the updater is constructed per call with an explicit endpoint instead
/// of relying on the one in `tauri.conf.json`.
fn update_feed_url(settings: &Value) -> Option<String> {
    let base_url = string_setting(settings, &["appUpdates", "baseUrl"])
        .trim()
        .trim_end_matches('/')
        .to_string();

    if base_url.is_empty() {
        return None;
    }

    Some(format!("{base_url}/latest.json"))
}

fn app_update_snapshot(
    status: &str,
    current_version: &str,
    feed_url: Option<&str>,
    message: impl Into<String>,
) -> Value {
    json!({
        "status": status,
        "currentVersion": current_version,
        "availableVersion": Value::Null,
        "releaseName": Value::Null,
        "releaseNotes": Value::Null,
        "releaseDate": Value::Null,
        "feedUrl": feed_url,
        "downloadUrl": Value::Null,
        "lastCheckedAt": Value::Null,
        "downloadedAt": Value::Null,
        "message": message.into(),
    })
}

/// Asks the feed whether there is anything newer, and remembers the answer so
/// installing does not have to ask again.
async fn check_for_update(app: &tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;

    let state = app.state::<AppState>();
    let settings = load_settings_from_state(&state)?;
    let current_version = app.package_info().version.to_string();

    if !bool_setting(&settings, &["appUpdates", "enabled"], false) {
        return Ok(app_update_snapshot(
            "disabled",
            &current_version,
            None,
            "Update checks are switched off in Settings.",
        ));
    }

    let Some(feed_url) = update_feed_url(&settings) else {
        return Ok(app_update_snapshot(
            "disabled",
            &current_version,
            None,
            "Set an update feed address in Settings to check for new versions.",
        ));
    };

    let endpoint = feed_url
        .parse()
        .map_err(|error| format!("\"{feed_url}\" is not a valid update address: {error}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("Could not prepare the update check: {error}"))?
        .build()
        .map_err(|error| format!("Could not prepare the update check: {error}"))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let available_version = update.version.clone();
            let release_notes = update.body.clone();
            let release_date = update.date.map(|date| date.to_string());
            let download_url = update.download_url.to_string();

            if let Ok(mut pending) = state.pending_update.lock() {
                *pending = Some(update);
            }

            Ok(json!({
                "status": "available",
                "currentVersion": current_version,
                "availableVersion": available_version,
                "releaseName": available_version,
                "releaseNotes": release_notes,
                "releaseDate": release_date,
                "feedUrl": feed_url,
                "downloadUrl": download_url,
                "lastCheckedAt": now_iso(),
                "downloadedAt": Value::Null,
                "message": format!("Version {available_version} is ready to install."),
            }))
        }
        Ok(None) => {
            if let Ok(mut pending) = state.pending_update.lock() {
                *pending = None;
            }

            Ok(json!({
                "status": "up-to-date",
                "currentVersion": current_version,
                "availableVersion": Value::Null,
                "releaseName": Value::Null,
                "releaseNotes": Value::Null,
                "releaseDate": Value::Null,
                "feedUrl": feed_url,
                "downloadUrl": Value::Null,
                "lastCheckedAt": now_iso(),
                "downloadedAt": Value::Null,
                "message": "This is the newest version.",
            }))
        }
        Err(error) => Ok(json!({
            "status": "error",
            "currentVersion": current_version,
            "availableVersion": Value::Null,
            "releaseName": Value::Null,
            "releaseNotes": Value::Null,
            "releaseDate": Value::Null,
            "feedUrl": feed_url,
            "downloadUrl": Value::Null,
            "lastCheckedAt": now_iso(),
            "downloadedAt": Value::Null,
            "message": format!("Could not reach the update feed: {error}"),
        })),
    }
}

/* -------------------------------------------------------------------- auth */

/// Operator sign-in, over OAuth 2.0 with PKCE and a loopback redirect.
///
/// This is Clerk's own documented flow for native applications, and it lives in
/// the host rather than the webview for three reasons.
///
/// Google refuses OAuth from an embedded webview, so the sign-in has to happen
/// in the operator's real browser either way. A loopback address cannot be
/// hijacked the way a custom URL scheme can — any other application on the
/// machine is free to register `csnmediabridge://` and intercept the callback,
/// which is why RFC 8252 recommends loopback for native apps. And the refresh
/// token is long-lived, so it belongs in the application-support directory
/// rather than in webview local storage.
///
/// None of this governs the pipeline. The station authenticates to Convex with
/// its own machine credential; a signed-out station still ingests.
const AUTH_FILE_NAME: &str = "auth.json";
const AUTH_UPDATED_EVENT: &str = "media-bridge:auth-updated";
/// Long enough for a password manager, a second factor and a consent screen.
const AUTH_CALLBACK_TIMEOUT_SECONDS: u64 = 300;
/// Every port the loopback callback may land on. All three must be registered
/// as redirect URIs in the Clerk OAuth application.
const AUTH_CALLBACK_PORTS: &[u16] = &[4517, 4518, 4519];
/// `user:org:read` is what puts the organization claims in the token and makes
/// Clerk show the team picker on the consent screen. `offline_access` is what
/// asks for a refresh token — without it the session simply dies when the
/// access token expires and the operator is bounced back to the gate.
///
/// `openid` is deliberately absent. It only buys an ID token, which this app
/// never reads — identity comes from the userinfo endpoint, and from the access
/// token's own claims if that endpoint is not available to the granted scopes.
/// Asking for a scope the client is not allowed fails the entire sign-in, so it
/// is not requested on the chance it might be useful.
const AUTH_SCOPES: &str = "profile email offline_access user:org:read";

fn auth_file_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(AUTH_FILE_NAME))
}

fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A high-entropy PKCE verifier. `create_id` is a timestamp and a counter, so
/// it is deliberately not used here.
fn random_url_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut buffer = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    base64_url_encode(&buffer)
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    base64_url_encode(&hasher.finalize())
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn auth_issuer(settings: &Value) -> String {
    string_setting(settings, &["auth", "issuer"])
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn auth_client_id(settings: &Value) -> String {
    string_setting(settings, &["auth", "clientId"])
        .trim()
        .to_string()
}

/// A build with no issuer and no client id runs ungated, exactly as the app did
/// before sign-in existed.
fn auth_is_configured(settings: &Value) -> bool {
    !auth_issuer(settings).is_empty() && !auth_client_id(settings).is_empty()
}

fn write_auth_file(session: Option<&Value>) -> Result<(), String> {
    let path = auth_file_path()?;

    let Some(session) = session else {
        secure_write_secret(AUTH_SESSION_KEYCHAIN_ACCOUNT, "")?;
        let _ = fs::remove_file(&path);
        return Ok(());
    };

    let serialized = serde_json::to_string_pretty(session)
        .map_err(|error| format!("Could not serialize the session: {error}"))?;
    secure_write_secret(AUTH_SESSION_KEYCHAIN_ACCOUNT, &serialized)?;
    let _ = fs::remove_file(&path);
    Ok(())
}

/// What the renderer is told. Never includes a token — the host attaches those.
fn auth_public_snapshot(settings: &Value, session: Option<&Value>) -> Value {
    if !auth_is_configured(settings) {
        return json!({
            "status": "unconfigured",
            "person": Value::Null,
            "team": Value::Null,
        });
    }

    match session {
        Some(session) => json!({
            "status": "signed-in",
            "person": session.get("person").cloned().unwrap_or(Value::Null),
            "team": session.get("team").cloned().unwrap_or(Value::Null),
        }),
        None => json!({
            "status": "signed-out",
            "person": Value::Null,
            "team": Value::Null,
        }),
    }
}

/// Replaces the stored session. Confined to its own function because the
/// `State` borrow and the mutex guard cannot outlive the statement they are
/// created in.
fn log_to_app(app: &tauri::AppHandle, level: &str, source: &str, message: impl Into<String>) {
    let state = app.state::<AppState>();
    let _ = append_log(&state, level, source, message.into(), None);
}

fn store_auth_session(app: &tauri::AppHandle, session: Option<Value>) {
    let state = app.state::<AppState>();
    // Bound rather than matched inline: an `if let` scrutinee keeps its
    // temporary alive past the end of the borrow.
    let locked = state.auth_session.lock();
    if let Ok(mut current) = locked {
        *current = session;
    }
}

fn emit_auth_update(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Ok(settings) = settings_snapshot_from_state(&state) else {
        return;
    };
    let session = state
        .auth_session
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let _ = app.emit(
        AUTH_UPDATED_EVENT,
        auth_public_snapshot(&settings, session.as_ref()),
    );
}

/// Reads one HTTP request off the loopback socket and answers it, so the
/// operator's browser lands on a page saying they can go back to the app.
fn read_callback_query(mut stream: TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;

    let target = request_line.split_whitespace().nth(1)?.to_string();

    let body = "<!doctype html><meta charset=\"utf-8\"><title>Media Bridge</title>\
<body style=\"margin:0;display:grid;place-items:center;height:100vh;background:#050505;color:#fbfef9;\
font-family:system-ui,sans-serif\"><div style=\"text-align:center\">\
<p style=\"font-size:17px;margin:0\">You're signed in.</p>\
<p style=\"font-size:14px;color:#9a9a9a;margin:10px 0 0\">You can close this tab and go back to Media Bridge.</p>\
</div>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    target.split_once('?').map(|(_, query)| query.to_string())
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name != key {
            return None;
        }

        // Only the characters Clerk actually puts in these values.
        let mut decoded = String::with_capacity(value.len());
        let mut bytes = value.bytes();
        while let Some(byte) = bytes.next() {
            match byte {
                b'+' => decoded.push(' '),
                b'%' => {
                    let hex: String = bytes.by_ref().take(2).map(|b| b as char).collect();
                    match u8::from_str_radix(&hex, 16) {
                        Ok(decoded_byte) => decoded.push(decoded_byte as char),
                        Err(_) => return None,
                    }
                }
                _ => decoded.push(byte as char),
            }
        }
        Some(decoded)
    })
}

async fn exchange_authorization_code(
    issuer: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{issuer}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach the sign-in service: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read the sign-in response: {error}"))?;

    if !status.is_success() {
        // `invalid_client` here means the token endpoint wanted client
        // authentication. A desktop app cannot hold a secret, so the answer is
        // always to mark the OAuth application public rather than to start
        // shipping one.
        if text.contains("invalid_client") {
            return Err(
                "The sign-in service would not accept this app: it is registered as a \
                 confidential client, which expects a client secret. A desktop app cannot \
                 keep a secret, so mark the OAuth application as a public client — it then \
                 authenticates with PKCE instead."
                    .to_string(),
            );
        }

        return Err(format!(
            "The sign-in service refused the request ({status}): {text}"
        ));
    }

    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse the sign-in response: {error}"))
}

/// Reads the claims out of a JWT access token without verifying it.
///
/// Verification would be pointless here and is not skipped carelessly: this
/// token came back over TLS from a token endpoint this process just called, so
/// it has not crossed a trust boundary. It is a fallback for reading `sub` and
/// the organization claims when the userinfo endpoint is not available to the
/// scopes that were granted.
fn access_token_claims(access_token: &str) -> Option<Value> {
    use base64::Engine;

    let payload = access_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;

    serde_json::from_slice::<Value>(&decoded).ok()
}

async fn fetch_userinfo(issuer: &str, access_token: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(format!("{issuer}/oauth/userinfo"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Could not read your profile: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Could not read your profile ({}).",
            response.status()
        ));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not parse your profile: {error}"))
}

/// Identity for the signed-in operator.
///
/// The userinfo endpoint is the good answer, but it is an OpenID Connect
/// endpoint and an instance may not serve it to a token granted only OAuth
/// scopes. Rather than fail a sign-in that otherwise succeeded, the token's own
/// claims stand in.
async fn resolve_identity(issuer: &str, access_token: &str) -> Value {
    match fetch_userinfo(issuer, access_token).await {
        Ok(userinfo) => userinfo,
        Err(_) => access_token_claims(access_token).unwrap_or_else(|| json!({})),
    }
}

/// Folds a token response and an identity response into the session we persist.
fn build_auth_session(tokens: &Value, userinfo: &Value) -> Value {
    let expires_in = value_to_f64(tokens.get("expires_in")).unwrap_or(3600.0) as i64;
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in.max(60) - 30);

    let name = trim_string(userinfo.get("name"))
        .or_else(|| trim_string(userinfo.get("preferred_username")))
        .or_else(|| trim_string(userinfo.get("email")))
        .unwrap_or_else(|| "Signed in".to_string());

    // `org_id` is the only organization claim an instance is guaranteed to
    // advertise; the name and slug are best-effort, so the label falls back
    // through them rather than showing a bare identifier.
    let team = trim_string(userinfo.get("org_id")).map(|org_id| {
        let name = trim_string(userinfo.get("org_name"))
            .or_else(|| trim_string(userinfo.get("org_slug")))
            .unwrap_or_else(|| "Your team".to_string());

        json!({
            "id": org_id,
            "name": name,
            "slug": userinfo.get("org_slug").cloned().unwrap_or(Value::Null),
        })
    });

    json!({
        "accessToken": tokens.get("access_token").cloned().unwrap_or(Value::Null),
        "refreshToken": tokens.get("refresh_token").cloned().unwrap_or(Value::Null),
        "expiresAt": expires_at.to_rfc3339(),
        "person": {
            "id": userinfo.get("sub").cloned().unwrap_or(Value::Null),
            "name": name,
            "email": userinfo.get("email").cloned().unwrap_or(Value::Null),
        },
        "team": team,
    })
}

/// Why a renewal did not happen.
///
/// The difference decides whether the operator stays signed in. A station in a
/// truck or a venue with no uplink must not be logged out of screens that need
/// no network at all — being unable to *ask* is not the same as being refused.
enum RefreshFailure {
    /// The sign-in service could not be reached. The session is still good.
    Unreachable(String),
    /// The service answered and rejected the refresh token. The session is done.
    Rejected(String),
}

/// Trades the refresh token for a new access token when the old one is spent.
async fn refresh_auth_session(settings: &Value, session: &Value) -> Result<Value, RefreshFailure> {
    let refresh_token = trim_string(session.get("refreshToken")).ok_or_else(|| {
        RefreshFailure::Rejected("This session cannot be renewed; sign in again.".to_string())
    })?;
    let issuer = auth_issuer(settings);
    let client_id = auth_client_id(settings);

    let response = reqwest::Client::new()
        .post(format!("{issuer}/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|error| {
            RefreshFailure::Unreachable(format!("Could not reach the sign-in service: {error}"))
        })?;

    let status = response.status();
    if !status.is_success() {
        // 5xx is the service having a bad day, not a verdict on this session.
        return Err(if status.is_server_error() {
            RefreshFailure::Unreachable(format!(
                "The sign-in service is not answering properly ({status})."
            ))
        } else {
            RefreshFailure::Rejected("Your session has expired. Sign in again.".to_string())
        });
    }

    let tokens = response.json::<Value>().await.map_err(|error| {
        RefreshFailure::Unreachable(format!("Could not read the renewed session: {error}"))
    })?;
    let access_token = trim_string(tokens.get("access_token"))
        .ok_or_else(|| RefreshFailure::Rejected("The renewed session had no token.".to_string()))?;
    let identity = resolve_identity(&issuer, &access_token).await;

    let mut renewed = build_auth_session(&tokens, &identity);

    // Clerk does not always rotate the refresh token; keep the old one if so.
    if renewed
        .get("refreshToken")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        if let Some(map) = renewed.as_object_mut() {
            map.insert("refreshToken".to_string(), json!(refresh_token));
        }
    }

    Ok(renewed)
}

/// Opens the operator's real browser at Clerk, waits on a loopback port for the
/// redirect, and trades the code for a session.
#[tauri::command]
async fn auth_sign_in(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;

    let settings = {
        let state = app.state::<AppState>();
        settings_snapshot_from_state(&state)?
    };

    if !auth_is_configured(&settings) {
        return Err("This build has no sign-in configured.".to_string());
    }

    let issuer = auth_issuer(&settings);
    let client_id = auth_client_id(&settings);

    // A fixed set of ports rather than an ephemeral one: most authorization
    // servers match the redirect URI exactly, so every port this might use has
    // to be registered up front. Three gives room for another copy of the app,
    // or something else already holding the first.
    let listener = AUTH_CALLBACK_PORTS
        .iter()
        .find_map(|port| TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], *port))).ok())
        .ok_or_else(|| {
            format!(
                "Could not open a local port for sign-in. Ports {} are all in use.",
                AUTH_CALLBACK_PORTS
                    .iter()
                    .map(|port| port.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the local sign-in port: {error}"))?
        .port();
    // Non-blocking, so the deadline below can actually fire. A blocking accept
    // would wait forever on an operator who closed the browser, holding the
    // port against the next attempt.
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the local sign-in port: {error}"))?;

    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_url_token(64);
    let challenge = pkce_challenge(&verifier);
    let expected_state = random_url_token(24);

    let authorize_url = format!(
        "{issuer}/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        percent_encode(&client_id),
        percent_encode(&redirect_uri),
        percent_encode(AUTH_SCOPES),
        percent_encode(&expected_state),
        percent_encode(&challenge),
    );

    app.opener()
        .open_url(authorize_url, None::<&str>)
        .map_err(|error| format!("Could not open your browser: {error}"))?;

    // Blocking accept on a worker thread, so the window stays responsive while
    // the operator signs in.
    let (code, returned_state) = tauri::async_runtime::spawn_blocking(move || {
        let deadline = SystemTime::now() + Duration::from_secs(AUTH_CALLBACK_TIMEOUT_SECONDS);

        while SystemTime::now() < deadline {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(error) => return Err(format!("Sign-in was interrupted: {error}")),
            };

            // The accepted socket inherits the listener's non-blocking mode,
            // which would make reading the request return WouldBlock instead of
            // the request line.
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));

            let Some(query) = read_callback_query(stream) else {
                continue;
            };

            if let Some(error) = query_value(&query, "error") {
                // The description is where the useful part lives — "invalid_scope"
                // alone sends you hunting, while the description names the scope
                // the client was not allowed to ask for.
                let detail = query_value(&query, "error_description")
                    .map(|detail| format!(" — {detail}"))
                    .unwrap_or_default();
                return Err(format!("Sign-in was refused ({error}){detail}"));
            }

            if let Some(code) = query_value(&query, "code") {
                let state = query_value(&query, "state").unwrap_or_default();
                return Ok((code, state));
            }
        }

        Err("Sign-in timed out. Try again.".to_string())
    })
    .await
    .map_err(|error| format!("Sign-in was interrupted: {error}"))??;

    // Guards against another page on the machine driving this callback.
    if returned_state != expected_state {
        return Err("Sign-in could not be verified. Try again.".to_string());
    }

    let tokens =
        exchange_authorization_code(&issuer, &client_id, &code, &verifier, &redirect_uri).await?;
    let access_token = trim_string(tokens.get("access_token"))
        .ok_or_else(|| "The sign-in service returned no token.".to_string())?;
    let identity = resolve_identity(&issuer, &access_token).await;
    let session = build_auth_session(&tokens, &identity);

    write_auth_file(Some(&session))?;

    let who = session
        .get("person")
        .and_then(|person| person.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Someone")
        .to_string();

    store_auth_session(&app, Some(session.clone()));
    log_to_app(&app, "info", "system", format!("{who} signed in."));
    emit_auth_update(&app);

    Ok(auth_public_snapshot(&settings, Some(&session)))
}

#[tauri::command]
async fn auth_status(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let settings = settings_snapshot_from_state(&state)?;
    let session = state
        .auth_session
        .lock()
        .map_err(|_| "Sign-in state is unavailable.".to_string())?
        .clone();

    Ok(auth_public_snapshot(&settings, session.as_ref()))
}

/// Signs out locally and tells Clerk to drop the refresh token, so a stolen
/// copy of `auth.json` stops working rather than lasting until it expires.
#[tauri::command]
async fn auth_sign_out(app: tauri::AppHandle) -> Result<Value, String> {
    let (settings, session) = {
        let state = app.state::<AppState>();
        let settings = settings_snapshot_from_state(&state)?;
        let session = state
            .auth_session
            .lock()
            .map_err(|_| "Sign-in state is unavailable.".to_string())?
            .take();
        (settings, session)
    };

    write_auth_file(None)?;

    if let Some(session) = session.as_ref() {
        if let Some(refresh_token) = trim_string(session.get("refreshToken")) {
            let _ = reqwest::Client::new()
                .post(format!("{}/oauth/revoke", auth_issuer(&settings)))
                .form(&[
                    ("token", refresh_token.as_str()),
                    ("client_id", auth_client_id(&settings).as_str()),
                ])
                .send()
                .await;
        }
    }

    emit_auth_update(&app);
    Ok(auth_public_snapshot(&settings, None))
}

/// A valid access token for calling a service that trusts this Clerk instance,
/// renewed first if it is spent. Returns null when signed out, so callers have
/// to handle an unattended station rather than assume an operator.
#[tauri::command]
async fn auth_get_token(app: tauri::AppHandle) -> Result<Value, String> {
    let (settings, session) = {
        let state = app.state::<AppState>();
        let settings = settings_snapshot_from_state(&state)?;
        let session = state
            .auth_session
            .lock()
            .map_err(|_| "Sign-in state is unavailable.".to_string())?
            .clone();
        (settings, session)
    };

    let Some(session) = session else {
        return Ok(Value::Null);
    };

    let still_valid = trim_string(session.get("expiresAt"))
        .and_then(|expires_at| chrono::DateTime::parse_from_rfc3339(&expires_at).ok())
        .map(|expires_at| expires_at > chrono::Utc::now())
        .unwrap_or(false);

    if still_valid {
        return Ok(session.get("accessToken").cloned().unwrap_or(Value::Null));
    }

    match refresh_auth_session(&settings, &session).await {
        Ok(renewed) => {
            write_auth_file(Some(&renewed))?;
            let token = renewed.get("accessToken").cloned().unwrap_or(Value::Null);
            store_auth_session(&app, Some(renewed));
            emit_auth_update(&app);
            Ok(token)
        }
        // Unreachable is not a verdict. The station keeps its session and the
        // operator keeps the screens that need no network; only the call that
        // wanted a token goes without one.
        Err(RefreshFailure::Unreachable(reason)) => {
            log_to_app(
                &app,
                "warn",
                "system",
                format!("{reason} Staying signed in — this station keeps working offline."),
            );
            Ok(Value::Null)
        }
        // Refused is a verdict, so the session goes.
        Err(RefreshFailure::Rejected(reason)) => {
            write_auth_file(None)?;
            store_auth_session(&app, None);
            log_to_app(&app, "warn", "system", reason);
            emit_auth_update(&app);
            Ok(Value::Null)
        }
    }
}

#[tauri::command]
async fn get_state(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    state_snapshot(&state)
}

#[tauri::command]
async fn load_startup_settings(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    settings_snapshot_from_state(&state)
}

#[tauri::command]
async fn load_settings(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    load_settings_from_state(&state)
}

#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: Value,
) -> Result<Value, String> {
    let mut stored_settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?;
    let merged_settings = normalize_settings_value(merge_defaults(default_settings(), settings));
    write_settings_file(&merged_settings)?;
    *stored_settings = merged_settings.clone();
    drop(stored_settings);

    let result = json!({
        "settings": merged_settings,
        "state": state_snapshot(&state)?
    });

    // Turning sign-in on or off here changes whether the window should be
    // gated, so the gate is told rather than waiting for a restart.
    emit_auth_update(&app);

    Ok(result)
}

#[tauri::command]
async fn import_connection_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let picked_file = app
        .dialog()
        .file()
        .set_title("Import Connection Profile")
        .add_filter("Connection Profile", &["json"])
        .blocking_pick_file();
    let Some(path) = picked_file else {
        return Ok(json!({
            "canceled": true,
            "profileName": null,
            "path": null,
            "settings": load_settings_from_state(&state)?,
            "state": state_snapshot(&state)?,
        }));
    };
    let profile_path = path
        .into_path()
        .map_err(|error| format!("Could not resolve selected profile: {error}"))?;
    let profile_text = fs::read_to_string(&profile_path)
        .map_err(|error| format!("Could not read {}: {error}", profile_path.display()))?;
    let profile = serde_json::from_str::<Value>(&profile_text)
        .map_err(|error| format!("Could not parse {}: {error}", profile_path.display()))?;
    let profile_name = connection_profile_name(&profile);
    let current_settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();
    let merged_settings =
        normalize_settings_value(apply_connection_profile(&current_settings, &profile));
    write_settings_file(&merged_settings)?;

    {
        let mut stored_settings = state
            .settings
            .lock()
            .map_err(|_| "Settings lock is unavailable.".to_string())?;
        *stored_settings = merged_settings.clone();
    }

    let snapshot = state_snapshot(&state)?;
    emit_state_update(&app);

    Ok(json!({
        "canceled": false,
        "profileName": profile_name,
        "path": profile_path.to_string_lossy().to_string(),
        "settings": merged_settings,
        "state": snapshot,
    }))
}

#[tauri::command]
async fn export_connection_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile_name: Option<String>,
) -> Result<Value, String> {
    let picked_file = app
        .dialog()
        .file()
        .set_title("Export Connection Profile")
        .set_file_name("media-bridge.connection-profile.json")
        .add_filter("Connection Profile", &["json"])
        .blocking_save_file();
    let Some(path) = picked_file else {
        return Ok(json!({
            "canceled": true,
            "profileName": null,
            "path": null,
        }));
    };
    let profile_path = path
        .into_path()
        .map_err(|error| format!("Could not resolve profile destination: {error}"))?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();
    let normalized_profile_name = profile_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Media Bridge Connection Profile".to_string());
    let profile = build_connection_profile(&settings, &normalized_profile_name);
    let serialized = serde_json::to_string_pretty(&profile)
        .map_err(|error| format!("Could not serialize connection profile: {error}"))?;

    fs::write(&profile_path, format!("{serialized}\n"))
        .map_err(|error| format!("Could not write {}: {error}", profile_path.display()))?;

    Ok(json!({
        "canceled": false,
        "profileName": normalized_profile_name,
        "path": profile_path.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
async fn check_for_app_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let snapshot = check_for_update(&app).await?;

    if let Some(message) = snapshot.get("message").and_then(Value::as_str) {
        append_log(&state, "info", "system", message.to_string(), None)?;
    }

    if let Ok(mut app_update) = state.app_update.lock() {
        *app_update = Some(snapshot);
    }

    state_snapshot(&state)
}

/// Downloads and installs the update found by the last check, then restarts
/// into it. Tauri verifies the signature before anything is written, so a feed
/// that has been tampered with fails here rather than installing.
#[tauri::command]
async fn install_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // The check populates this. Asking to install without one is a UI bug, but
    // re-checking is cheaper than failing on it.
    let pending = {
        let mut pending = state
            .pending_update
            .lock()
            .map_err(|_| "Update state is unavailable.".to_string())?;
        pending.take()
    };

    let update = match pending {
        Some(update) => update,
        None => {
            check_for_update(&app).await?;
            let mut pending = state
                .pending_update
                .lock()
                .map_err(|_| "Update state is unavailable.".to_string())?;
            pending
                .take()
                .ok_or_else(|| "There is no newer version to install.".to_string())?
        }
    };

    let version = update.version.clone();
    append_log(
        &state,
        "info",
        "system",
        format!("Downloading version {version}."),
        None,
    )?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| format!("Could not install version {version}: {error}"))?;

    append_log(
        &state,
        "info",
        "system",
        format!("Version {version} is installed. Restarting."),
        None,
    )?;

    app.restart();
}

#[tauri::command]
async fn start_watching(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    let watch_folder = string_setting(&settings, &["watchFolder"])
        .trim()
        .to_string();

    if watch_folder.is_empty() {
        return Err("Choose a folder to watch before starting.".to_string());
    }

    if !Path::new(&watch_folder).is_dir() {
        return Err(format!("Could not read {watch_folder}."));
    }

    if state.watching.swap(true, Ordering::SeqCst) {
        return state_snapshot(&state);
    }

    append_log(
        &state,
        "info",
        "watcher",
        format!("Watching {watch_folder} for new videos."),
        None,
    )?;

    let watching = Arc::clone(&state.watching);
    let worker_app = app.clone();
    thread::spawn(move || {
        watch_folder_loop(worker_app, watching);
    });

    state_snapshot(&state)
}

#[tauri::command]
async fn stop_watching(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    if state.watching.swap(false, Ordering::SeqCst) {
        append_log(
            &state,
            "info",
            "watcher",
            "Stopped watching. Videos already in progress will finish.",
            None,
        )?;
    }

    state_snapshot(&state)
}

#[tauri::command]
async fn browse_directory(app: tauri::AppHandle) -> Result<Value, String> {
    let picked_folder = app
        .dialog()
        .file()
        .set_title("Choose Folder")
        .blocking_pick_folder();

    match picked_folder {
        Some(path) => Ok(json!({
            "canceled": false,
            "path": pick_path_to_string(path)?,
        })),
        None => Ok(json!({
            "canceled": true,
            "path": null,
        })),
    }
}

#[tauri::command]
async fn choose_manual_intake_source(app: tauri::AppHandle) -> Result<Value, String> {
    let picked_file = app
        .dialog()
        .file()
        .set_title("Choose Video")
        .add_filter("Video Files", &["mp4", "m4v", "mov", "webm", "mkv"])
        .blocking_pick_file();

    match picked_file {
        Some(path) => {
            let path = path
                .into_path()
                .map_err(|error| format!("Could not resolve selected file: {error}"))?;
            inspect_manual_file(path, false)
        }
        None => Ok(Value::Null),
    }
}

#[tauri::command]
async fn enqueue_manual_intake(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let (snapshot, job_id) = create_manual_job(&state, request)?;
    emit_state_update(&app);

    if let Some(job_id) = job_id {
        std::thread::spawn(move || {
            process_queued_job(app, job_id);
        });
    }

    Ok(snapshot)
}

/// Retrying puts the same source file back through the queue, carrying its
/// metadata over so the operator does not have to type it again. The failed
/// job stays in the history; this is a new run, not a resurrected one.
#[tauri::command]
async fn retry_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    let job = match get_job(&state, &job_id) {
        Ok(job) => job,
        Err(_) => return state_snapshot(&state),
    };

    let mut request = serde_json::Map::new();
    request.insert(
        "sourcePath".to_string(),
        job.get("sourcePath").cloned().unwrap_or(Value::Null),
    );
    request.insert(
        "route".to_string(),
        Value::String(
            trim_string(job.get("pipelineRoute")).unwrap_or_else(|| "web_streaming".to_string()),
        ),
    );

    for key in [
        "title",
        "description",
        "series",
        "recordedAt",
        "projectName",
        "eventName",
        "cameraId",
        "sourceNode",
        "tags",
        "playlistTitles",
    ] {
        if let Some(value) = job.get(key) {
            if !value.is_null() {
                request.insert(key.to_string(), value.clone());
            }
        }
    }

    let (snapshot, next_job_id) = create_manual_job(&state, Value::Object(request))?;
    emit_state_update(&app);

    if let Some(next_job_id) = next_job_id {
        std::thread::spawn(move || {
            process_queued_job(app, next_job_id);
        });
    }

    Ok(snapshot)
}

#[tauri::command]
async fn audit_job_uploads(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    audit_job_uploads_inner(&state, &job_id)
}

/// Runs the same source through again, writing to the object keys it already
/// has. rclone skips what is already there byte-for-byte, so a resume costs
/// only the pieces that never arrived.
#[tauri::command]
async fn resume_job_uploads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    let job = get_job(&state, &job_id)?;

    if trim_string(job.get("archiveObjectKey")).is_none()
        && trim_string(job.get("distributionObjectKey")).is_none()
    {
        return Err("This one does not have a cloud folder to resume into yet.".to_string());
    }

    update_job(
        &state,
        &job_id,
        json!({
            "status": "queued",
            "stage": "file-ready",
            "message": "Picking up the upload where it left off.",
            "errorMessage": Value::Null,
            "completedAt": Value::Null,
            "updatedAt": now_iso(),
        }),
    )?;

    append_log(
        &state,
        "info",
        "sync",
        format!(
            "Resuming the upload for {} into the same cloud folder.",
            trim_string(job.get("sourceName")).unwrap_or_default()
        ),
        Some(job_id.clone()),
    )?;

    emit_state_update(&app);

    let worker_app = app.clone();
    let worker_job_id = job_id.clone();
    std::thread::spawn(move || {
        process_queued_job(worker_app, worker_job_id);
    });

    state_snapshot(&state)
}

/// Clears a half-finished upload out of the cloud so the next attempt starts
/// from nothing rather than from a partial package that looks complete.
#[tauri::command]
async fn cleanup_job_uploads(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    let job = get_job(&state, &job_id)?;

    if let Some(archive_object_key) = trim_string(job.get("archiveObjectKey")) {
        delete_remote_file(
            &settings,
            "csnb2",
            string_setting(&settings, &["b2", "bucket"]),
            &archive_object_key,
        )?;
    }

    if let Some(distribution_object_key) = trim_string(job.get("distributionObjectKey")) {
        purge_remote_prefix(
            &settings,
            "csnr2",
            string_setting(&settings, &["r2", "bucket"]),
            &distribution_object_key,
        )?;
    }

    update_job(
        &state,
        &job_id,
        json!({
            "message": "Cleared the half-finished upload out of the cloud.",
            "updatedAt": now_iso(),
        }),
    )?;

    append_log(
        &state,
        "info",
        "sync",
        format!(
            "Cleared the cloud folders for {}.",
            trim_string(job.get("sourceName")).unwrap_or_default()
        ),
        Some(job_id.clone()),
    )?;

    audit_job_uploads_inner(&state, &job_id)
}

#[tauri::command]
async fn refresh_system(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    state_snapshot(&state)
}

#[tauri::command]
async fn list_stored_videos(state: tauri::State<'_, AppState>) -> Result<Vec<Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();
    let proxy_origin = ensure_media_proxy_origin(&state)?;
    let videos = list_all_stored_videos(&settings).await?;

    Ok(videos
        .into_iter()
        .map(|video| proxy_stored_video_urls(video, &settings, &proxy_origin))
        .collect())
}

/// Forwards the editor's changes to the library. Only the keys the renderer
/// actually sent are forwarded, so an edit of one field cannot blank the rest.
#[tauri::command]
async fn update_stored_video_metadata(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<(), String> {
    let settings = load_settings_from_state(&state)?;
    require_convex(&settings)?;

    let mut args = request
        .as_object()
        .cloned()
        .ok_or_else(|| "Stored video metadata request must be an object.".to_string())?;

    if !args.contains_key("videoId") {
        return Err("Stored video metadata request is missing a video id.".to_string());
    }

    if let Some(title) = args.get("title").and_then(Value::as_str) {
        let trimmed = title.trim().to_string();
        args.insert(
            "title".to_string(),
            if trimmed.is_empty() {
                Value::Null
            } else {
                Value::String(trimmed)
            },
        );
    }

    call_convex_mutation(
        &settings,
        &derive_convex_function_path(&settings, "updateVideoMetadata"),
        Value::Object(args),
    )
    .await
    .map(|_| ())
}

/// Deletes the library record and the cloud objects behind it. The stored
/// objects go first: a record whose files are gone is recoverable by hand, but
/// files with no record are invisible and bill forever.
#[tauri::command]
async fn delete_stored_video(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    require_convex(&settings)?;

    let video_id = trim_string(request.get("videoId"))
        .ok_or_else(|| "Stored video deletion needs a video id.".to_string())?;
    let title = trim_string(request.get("title")).unwrap_or_else(|| video_id.clone());
    let source_file_name = trim_string(request.get("sourceFileName")).unwrap_or_default();
    let archive_object_key = trim_string(request.get("archiveObjectKey"));
    let distribution_object_key = trim_string(request.get("distributionObjectKey"));
    let job_id = format!("delete:{video_id}");

    let mut deleted_archive = false;
    if let Some(archive_object_key) = archive_object_key.filter(|key| !key.is_empty()) {
        delete_remote_file(
            &settings,
            "csnb2",
            string_setting(&settings, &["b2", "bucket"]),
            &archive_object_key,
        )?;
        deleted_archive = true;
        append_log(
            &state,
            "info",
            "sync",
            format!("Removed the archived original {archive_object_key}."),
            Some(job_id.clone()),
        )?;
    }

    let mut deleted_distribution = false;
    if let Some(distribution_object_key) = distribution_object_key.filter(|key| !key.is_empty()) {
        purge_remote_prefix(
            &settings,
            "csnr2",
            string_setting(&settings, &["r2", "bucket"]),
            &distribution_object_key,
        )?;
        deleted_distribution = true;
        append_log(
            &state,
            "info",
            "sync",
            format!("Removed the playback package {distribution_object_key}."),
            Some(job_id.clone()),
        )?;
    }

    call_convex_mutation(
        &settings,
        &derive_convex_function_path(&settings, "deleteVideo"),
        json!({ "videoId": video_id }),
    )
    .await?;

    append_log(
        &state,
        "info",
        "convex",
        format!("Deleted {source_file_name} and removed its library record."),
        Some(job_id),
    )?;

    Ok(json!({
        "videoId": video_id,
        "title": title,
        "deletedRecord": true,
        "deletedArchive": deleted_archive,
        "deletedDistribution": deleted_distribution,
    }))
}

/// Rewrites every stored playback URL against the current public base.
///
/// Moving the CDN in front of R2, or correcting a mistyped base URL, leaves
/// every existing record pointing somewhere that no longer serves. This walks
/// the library, recomputes each record's URLs from its object keys, and
/// re-registers only the records that actually changed.
#[tauri::command]
async fn repair_stored_video_urls(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    require_convex(&settings)?;

    if string_setting(&settings, &["r2", "publicBaseUrl"])
        .trim()
        .is_empty()
    {
        return Err(
            "R2 Public Base URL is required before stored playback URLs can be repaired."
                .to_string(),
        );
    }

    let videos = list_all_stored_videos(&settings).await?;
    let inspected = videos.len();
    let mut updated = 0_u64;
    let mut skipped = 0_u64;

    for video in videos {
        let delivery_type = infer_stored_delivery_type(&video);
        let distribution_object_key =
            video_str(&video, "distributionObjectKey").unwrap_or_default();

        let next_manifest_url = if delivery_type == "hls" {
            Some(public_url_for(
                &settings,
                distribution_object_key,
                Some("master.m3u8"),
            ))
        } else {
            None
        };

        let next_dash_manifest_url =
            if delivery_type == "hls" && video_str(&video, "dashManifestUrl").is_some() {
                Some(public_url_for(
                    &settings,
                    distribution_object_key,
                    Some(DASH_MANIFEST_FILENAME),
                ))
            } else {
                video_str(&video, "dashManifestUrl").map(str::to_string)
            };

        let next_playback_url = if delivery_type == "hls" {
            next_manifest_url
                .clone()
                .or_else(|| video_str(&video, "playbackUrl").map(str::to_string))
                .unwrap_or_default()
        } else {
            stored_progressive_playback_url(&settings, &video)
        };

        let next_poster_url = if video_str(&video, "posterUrl").is_some() {
            Some(public_url_for(
                &settings,
                distribution_object_key,
                Some("poster.jpg"),
            ))
        } else {
            None
        };

        let next_sources = if delivery_type == "progressive" {
            video_sources(&video)
                .into_iter()
                .map(|source| {
                    let object_key = source
                        .get("objectKey")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mut next_source = source.as_object().cloned().unwrap_or_default();
                    next_source.insert(
                        "url".to_string(),
                        Value::String(public_url_for(&settings, &object_key, None)),
                    );
                    Value::Object(next_source)
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let already_current = stored_manifest_url(&video) == next_manifest_url
            && video_str(&video, "dashManifestUrl").map(str::to_string) == next_dash_manifest_url
            && video_str(&video, "playbackUrl").unwrap_or_default() == next_playback_url
            && video_str(&video, "posterUrl").map(str::to_string) == next_poster_url
            && video_sources(&video) == next_sources;

        if already_current {
            skipped += 1;
            continue;
        }

        let payload = stored_video_entry_payload(
            &video,
            json!({
                "deliveryType": delivery_type,
                "contentType": infer_stored_content_type(&video),
                "masterPlaylistUrl": next_manifest_url,
                "manifestUrl": next_manifest_url,
                "dashManifestUrl": next_dash_manifest_url,
                "playbackUrl": next_playback_url,
                "posterUrl": next_poster_url,
                "sources": if next_sources.is_empty() {
                    Value::Null
                } else {
                    Value::Array(next_sources)
                },
            }),
        );

        call_create_vod_entry(&settings, payload).await?;
        updated += 1;
    }

    append_log(
        &state,
        "info",
        "convex",
        format!("Repaired {updated} of {inspected} stored playback URLs."),
        None,
    )?;

    Ok(json!({
        "inspected": inspected,
        "updated": updated,
        "skipped": skipped,
    }))
}

/// Pulls four still frames out of the finished video so the operator can pick a
/// cover image. The frames are written to a scratch directory and handed back as
/// `file://` URLs; nothing is uploaded until one is chosen.
#[tauri::command]
async fn generate_stored_video_poster_candidates(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Vec<Value>, String> {
    let source_url = trim_string(request.get("sourceUrl")).ok_or_else(|| {
        "A playable source is required before poster candidates can be generated.".to_string()
    })?;
    let duration_seconds = value_to_f64(request.get("durationSeconds")).unwrap_or(0.0);

    let output_directory =
        std::env::temp_dir().join(create_id("csn-media-bridge-poster-candidates", 1));
    let _ = fs::remove_dir_all(&output_directory);
    fs::create_dir_all(&output_directory)
        .map_err(|error| format!("Could not create {}: {error}", output_directory.display()))?;

    let mut candidates = Vec::new();

    for (index, timestamp_seconds) in poster_candidate_times(duration_seconds)
        .into_iter()
        .enumerate()
    {
        let output_path = output_directory.join(format!("poster-candidate-{}.jpg", index + 1));
        run_ffmpeg(&[
            "-y".to_string(),
            "-ss".to_string(),
            format!("{timestamp_seconds:.3}"),
            "-i".to_string(),
            source_url.clone(),
            "-frames:v".to_string(),
            "1".to_string(),
            "-q:v".to_string(),
            "2".to_string(),
            output_path.to_string_lossy().to_string(),
        ])?;

        candidates.push(json!({
            "id": create_id("poster-candidate", index + 1),
            "label": format_poster_label(timestamp_seconds),
            "imageUrl": file_url(&output_path),
            "localPath": output_path.to_string_lossy(),
            "timestampSeconds": timestamp_seconds,
        }));
    }

    append_log(
        &state,
        "info",
        "transcode",
        format!(
            "Pulled {} cover frames from the finished video.",
            candidates.len()
        ),
        None,
    )?;

    Ok(candidates)
}

/// Publishes the chosen frame as the asset's cover image and points the library
/// record at it.
#[tauri::command]
async fn apply_stored_video_poster(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<String, String> {
    let settings = load_settings_from_state(&state)?;
    require_convex(&settings)?;

    if string_setting(&settings, &["r2", "bucket"])
        .trim()
        .is_empty()
        || string_setting(&settings, &["r2", "accountId"])
            .trim()
            .is_empty()
    {
        return Err(
            "Cloudflare R2 bucket and account settings are required before posters can be saved."
                .to_string(),
        );
    }

    if string_setting(&settings, &["r2", "accessKeyId"])
        .trim()
        .is_empty()
        || string_setting(&settings, &["r2", "secretAccessKey"])
            .trim()
            .is_empty()
    {
        return Err(
            "Cloudflare R2 credentials are required before posters can be saved.".to_string(),
        );
    }

    if string_setting(&settings, &["r2", "publicBaseUrl"])
        .trim()
        .is_empty()
    {
        return Err("R2 Public Base URL is required before posters can be saved.".to_string());
    }

    let video_id = trim_string(request.get("videoId"))
        .ok_or_else(|| "Applying a cover image needs a video id.".to_string())?;
    let distribution_object_key = trim_string(request.get("distributionObjectKey"))
        .ok_or_else(|| "Applying a cover image needs a playback folder.".to_string())?;
    let candidate_path = PathBuf::from(
        trim_string(request.get("candidatePath"))
            .ok_or_else(|| "Applying a cover image needs a chosen frame.".to_string())?,
    );

    if !candidate_path.is_file() {
        return Err(format!("Could not read {}.", candidate_path.display()));
    }

    let poster_object_key = resolve_poster_object_key(&distribution_object_key);
    let upload_concurrency = number_setting(&settings, &["uploadConcurrency"], 10.0) as u64;
    let bucket = string_setting(&settings, &["r2", "bucket"]).to_string();

    with_rclone_config(&settings, |config_path| {
        copy_to_rclone(
            &candidate_path,
            "csnr2",
            &bucket,
            &poster_object_key,
            config_path,
            false,
            upload_concurrency,
        )
    })?;

    let poster_url = join_public_url(
        string_setting(&settings, &["r2", "publicBaseUrl"]),
        &poster_object_key,
    );

    call_convex_mutation(
        &settings,
        &derive_convex_function_path(&settings, "updateVideoMetadata"),
        json!({
            "videoId": video_id,
            "posterUrl": poster_url,
        }),
    )
    .await?;

    append_log(
        &state,
        "info",
        "convex",
        format!("Cover image updated for {video_id}."),
        None,
    )?;

    Ok(poster_url)
}

/// A short-lived link to one archived master, minted fresh each time an asset
/// is opened. It is never persisted, so a stale URL sitting in a React state
/// tree expires on its own rather than lingering as a shareable link.
#[tauri::command]
async fn get_archive_preview_url(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    let expires_in_seconds: u64 = 60 * 60;

    if let Some(reason) = archive_unavailable_reason(&settings) {
        return Ok(json!({
            "url": null,
            "expiresInSeconds": expires_in_seconds,
            "unavailableReason": reason,
        }));
    }

    let archive_object_key = trim_string(request.get("archiveObjectKey"))
        .ok_or_else(|| "An archive object key is required.".to_string())?;
    let url = presign_b2_object_url(&settings, &archive_object_key, expires_in_seconds)?;

    // The key is logged; the signature is not.
    append_log(
        &state,
        "info",
        "sync",
        format!("Signed an archive preview link for {archive_object_key}."),
        None,
    )?;

    Ok(json!({
        "url": url,
        "expiresInSeconds": expires_in_seconds,
        "unavailableReason": null,
    }))
}

/// Brings an archived original back onto this machine so it can be trimmed. A
/// copy already sitting in the working folder is reused rather than pulled
/// down again — these files run to tens of gigabytes.
#[tauri::command]
async fn retrieve_archived_master(
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    let temp_output_path = string_setting(&settings, &["tempOutputPath"])
        .trim()
        .to_string();

    if temp_output_path.is_empty() {
        return Err(
            "Set a temp output folder in Settings before retrieving archived masters.".to_string(),
        );
    }

    if string_setting(&settings, &["b2", "bucket"])
        .trim()
        .is_empty()
        || string_setting(&settings, &["b2", "keyId"])
            .trim()
            .is_empty()
        || string_setting(&settings, &["b2", "applicationKey"])
            .trim()
            .is_empty()
    {
        return Err(
            "Backblaze B2 credentials are required before retrieving archived masters.".to_string(),
        );
    }

    let video_id = trim_string(request.get("videoId"))
        .ok_or_else(|| "Retrieving an original needs a video id.".to_string())?;
    let archive_object_key = trim_string(request.get("archiveObjectKey"))
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "This asset has no archived master in Backblaze B2.".to_string())?;
    let title = trim_string(request.get("title")).unwrap_or_else(|| video_id.clone());
    let source_file_name = trim_string(request.get("sourceFileName")).unwrap_or_default();

    let job_id = format!("retrieve:{video_id}");
    let target_directory = PathBuf::from(&temp_output_path)
        .join("retrieved")
        .join(&video_id);
    let file_stem = archive_object_key
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if source_file_name.is_empty() {
                None
            } else {
                Some(source_file_name.clone())
            }
        })
        .unwrap_or_else(|| "master".to_string());
    let local_file_path = target_directory.join(&file_stem);

    let already_local = fs::metadata(&local_file_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);

    if already_local {
        append_log(
            &state,
            "info",
            "sync",
            format!("Reusing the local copy of {title} already in the working folder."),
            Some(job_id.clone()),
        )?;
    } else {
        append_log(
            &state,
            "info",
            "sync",
            format!("Retrieving {title} from the archive."),
            Some(job_id.clone()),
        )?;
        download_from_b2(&settings, &archive_object_key, &local_file_path)?;
    }

    let metadata = fs::metadata(&local_file_path)
        .map_err(|error| format!("Could not inspect {}: {error}", local_file_path.display()))?;

    append_log(
        &state,
        "info",
        "sync",
        format!("{title} is ready to trim."),
        Some(job_id),
    )?;

    Ok(json!({
        "canceled": false,
        "source": {
            "sourcePath": local_file_path.to_string_lossy(),
            "sourceFileName": file_name(&local_file_path),
            "sourceUrl": file_url(&local_file_path),
            "fileSizeBytes": metadata.len(),
            "modifiedAt": metadata
                .modified()
                .map(system_time_to_iso)
                .unwrap_or_else(|_| now_iso()),
        },
    }))
}

#[tauri::command]
async fn choose_trim_source(app: tauri::AppHandle) -> Result<Value, String> {
    let picked_file = app
        .dialog()
        .file()
        .set_title("Choose Video Clip")
        .add_filter("Video Files", &["mp4", "m4v", "mov", "webm", "mkv"])
        .blocking_pick_file();

    match picked_file {
        Some(path) => {
            let path = path
                .into_path()
                .map_err(|error| format!("Could not resolve selected file: {error}"))?;
            inspect_manual_file(path, true)
        }
        None => Ok(Value::Null),
    }
}

/// Cuts a clip out of a local file and writes a fresh MP4 wherever the
/// operator points the save dialog. The export re-encodes rather than stream-
/// copies so the cut lands exactly on the chosen frame instead of the nearest
/// keyframe. A hardware encoder that gives out falls back to software, because
/// a slower clip is better than no clip.
#[tauri::command]
async fn trim_clip(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    let source_path = trim_string(request.get("sourcePath"))
        .ok_or_else(|| "Choose a video before exporting a clip.".to_string())?;
    let in_point_seconds = value_to_f64(request.get("inPointSeconds"))
        .unwrap_or(0.0)
        .max(0.0);
    let out_point_seconds = value_to_f64(request.get("outPointSeconds"))
        .unwrap_or(0.0)
        .max(in_point_seconds);

    if !in_point_seconds.is_finite() || !out_point_seconds.is_finite() {
        return Err("Trim points must be valid numbers.".to_string());
    }

    let clip_duration_seconds = ((out_point_seconds - in_point_seconds) * 1000.0).round() / 1000.0;
    if clip_duration_seconds < 0.1 {
        return Err("Trim selections must span at least 0.1 seconds.".to_string());
    }

    let source_path = PathBuf::from(&source_path);
    if !source_path.is_file() {
        return Err(format!("Could not read {}.", source_path.display()));
    }

    let default_name = format!(
        "{}-trimmed.mp4",
        source_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("clip")
    );
    let mut save_dialog = app
        .dialog()
        .file()
        .set_title("Export Trimmed Clip")
        .add_filter("MP4 Video", &["mp4"])
        .set_file_name(&default_name);

    if let Some(parent) = source_path.parent() {
        save_dialog = save_dialog.set_directory(parent);
    }

    let Some(picked_path) = save_dialog.blocking_save_file() else {
        return Ok(json!({
            "canceled": true,
            "outputPath": null,
            "durationSeconds": null,
            "effectiveEncoder": null,
        }));
    };

    let output_path = PathBuf::from(pick_path_to_string(picked_path)?);
    if output_path == source_path {
        return Err(
            "Choose a new file name for the trimmed export so the source clip is not overwritten."
                .to_string(),
        );
    }

    let settings = load_settings_from_state(&state)?;
    let preferred_encoder = effective_encoder(&settings);

    append_log(
        &state,
        "info",
        "transcode",
        format!(
            "Trim export started for {} ({in_point_seconds:.2}s – {out_point_seconds:.2}s).",
            file_name(&source_path)
        ),
        None,
    )?;

    let mut used_encoder = preferred_encoder;
    let mut export_result = run_trim_export(
        &source_path,
        &output_path,
        in_point_seconds,
        clip_duration_seconds,
        preferred_encoder,
    );

    if let Err(error) = &export_result {
        let can_fall_back = bool_setting(&settings, &["autoFallbackToSoftware"], true)
            && preferred_encoder != "software"
            && is_hardware_acceleration_failure(error);

        if can_fall_back {
            append_log(
                &state,
                "warn",
                "transcode",
                format!(
                    "Hardware trim export failed with {preferred_encoder}. Retrying with software libx264."
                ),
                None,
            )?;
            used_encoder = "software";
            export_result = run_trim_export(
                &source_path,
                &output_path,
                in_point_seconds,
                clip_duration_seconds,
                "software",
            );
        }
    }

    export_result?;

    append_log(
        &state,
        "info",
        "transcode",
        format!(
            "Trim export finished: {} ({used_encoder}).",
            file_name(&output_path)
        ),
        None,
    )?;

    Ok(json!({
        "canceled": false,
        "outputPath": output_path.to_string_lossy(),
        "durationSeconds": clip_duration_seconds,
        "effectiveEncoder": used_encoder,
    }))
}

#[tauri::command]
async fn list_clips_for_video(
    state: tauri::State<'_, AppState>,
    source_video_id: String,
) -> Result<Vec<Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();

    if !convex_is_configured(&settings) {
        return Ok(Vec::new());
    }

    let proxy_origin = ensure_media_proxy_origin(&state)?;
    let response = call_convex_query(
        &settings,
        &derive_convex_function_path(&settings, "listClipsForVideo"),
        json!({ "sourceVideoId": source_video_id }),
    )
    .await?;

    let clips = response
        .as_array()
        .cloned()
        .ok_or_else(|| "Convex clip list response is not an array.".to_string())?;

    Ok(clips
        .into_iter()
        .map(|clip| proxy_stored_video_urls(clip, &settings, &proxy_origin))
        .collect())
}

#[tauri::command]
async fn choose_offload_source(app: tauri::AppHandle) -> Result<Value, String> {
    let picked_folder = app
        .dialog()
        .file()
        .set_title("Choose Shoot Folder")
        .blocking_pick_folder();

    match picked_folder {
        Some(path) => {
            let path = path
                .into_path()
                .map_err(|error| format!("Could not resolve selected folder: {error}"))?;
            inspect_offload_directory(path)
        }
        None => Ok(Value::Null),
    }
}

#[tauri::command]
async fn get_offload_task(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    Ok(state
        .offload_task
        .lock()
        .map_err(|_| "Offload state is unavailable.".to_string())?
        .clone()
        .unwrap_or(Value::Null))
}

/// Starts a copy on a worker thread and hands back the first snapshot straight
/// away, so the screen shows the copy beginning rather than sitting on a dead
/// button for however long a 186 GB card takes.
#[tauri::command]
async fn run_offload_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: Value,
) -> Result<Value, String> {
    if state.offload_running.load(Ordering::SeqCst) {
        return Err("A card is already being copied. Pause or stop it first.".to_string());
    }

    let settings = load_settings_from_state(&state)?;
    state.offload_running.store(true, Ordering::SeqCst);
    state.offload_pause.store(false, Ordering::SeqCst);
    state.offload_cancel.store(false, Ordering::SeqCst);

    let starting = json!({
        "id": create_id("offload", 1),
        "status": "preparing",
        "message": "Preparing the offload package.",
        "sourcePath": request.get("sourcePath").cloned().unwrap_or(Value::Null),
        "sourceName": trim_string(request.get("sourcePath"))
            .map(|path| file_name(Path::new(&path)))
            .unwrap_or_default(),
        "jobName": request.get("jobName").cloned().unwrap_or(Value::Null),
        "localDestinationPath": Value::Null,
        "webReadyPath": Value::Null,
        "cloudObjectKey": Value::Null,
        "manifestPath": Value::Null,
        "logPath": Value::Null,
        "copyProgress": 0,
        "conversionProgress": 0,
        "uploadProgress": 0,
        "overallProgress": 0,
        "totalFiles": 0,
        "imageCount": 0,
        "copiedFiles": 0,
        "totalBytes": 0,
        "copiedBytes": 0,
        "convertedImageCount": 0,
        "skippedFiles": 0,
        "uploadEnabled": request.get("uploadToB2").cloned().unwrap_or(json!(false)),
        "startedAt": now_iso(),
        "completedAt": Value::Null,
        "errorMessage": Value::Null,
    });

    if let Ok(mut task) = state.offload_task.lock() {
        *task = Some(starting.clone());
    }

    let worker_app = app.clone();
    std::thread::spawn(move || {
        run_offload(worker_app, request, settings);
    });

    Ok(starting)
}

/// Asks the copy to stop at the next file boundary. What has already been
/// copied stays where it is, and resuming picks up from the manifest.
#[tauri::command]
async fn pause_offload_task(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    if state.offload_running.load(Ordering::SeqCst) {
        state.offload_pause.store(true, Ordering::SeqCst);
    }

    Ok(state
        .offload_task
        .lock()
        .map_err(|_| "Offload state is unavailable.".to_string())?
        .clone()
        .unwrap_or(Value::Null))
}

/// Stops the copy for good. Nothing already written is removed, and nothing
/// was ever removed from the card.
#[tauri::command]
async fn cancel_offload_task(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    if state.offload_running.load(Ordering::SeqCst) {
        state.offload_cancel.store(true, Ordering::SeqCst);
    }

    Ok(state
        .offload_task
        .lock()
        .map_err(|_| "Offload state is unavailable.".to_string())?
        .clone()
        .unwrap_or(Value::Null))
}

#[tauri::command]
async fn get_storage_usage() -> Result<Value, String> {
    Ok(Value::Null)
}

#[tauri::command]
async fn list_live_stream_handoff_jobs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();

    if !convex_is_configured(&settings) {
        return cached_handoff_jobs(&state);
    }

    refresh_handoff_jobs(&app, &settings).await
}

/// Turns a backend refusal into something an operator can act on. The one that
/// matters most is a deployment that has not had the handoff functions added
/// yet — Convex's own wording for that reads like a crash.
fn plain_handoff_error(error: &str) -> String {
    if error.contains("Could not find public function") || error.contains("Could not find function")
    {
        return "The library does not support live recordings yet. The backend work is described in docs/LIVE_RECORDING_HANDOFF.md in the CSN sports app.".to_string();
    }
    error.to_string()
}

/// Everything a claim needs before it is worth asking the library for a job.
fn handoff_claim_preconditions(settings: &Value) -> Result<(), String> {
    if !convex_is_configured(settings) {
        return Err(
            "Connect the library in Settings before converting live recordings.".to_string(),
        );
    }
    if !storage_is_configured(settings) {
        return Err(
            "Set up cloud storage in Settings before converting live recordings.".to_string(),
        );
    }
    Ok(())
}

/// Releases the station's handoff slot however processing ends — including a
/// panic deep in an encode — so one bad recording cannot stop every later one.
struct HandoffSlot(Arc<AtomicBool>);

impl Drop for HandoffSlot {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Takes the station's handoff slot, or says plainly why it cannot.
fn take_handoff_slot(state: &tauri::State<'_, AppState>) -> Result<HandoffSlot, String> {
    let running = Arc::clone(&state.live_handoff_running);
    if running.swap(true, Ordering::SeqCst) {
        return Err("This station is already converting a live recording. It will take the next one when it finishes.".to_string());
    }
    Ok(HandoffSlot(running))
}

/// Records a claimed job and converts it on its own thread. The slot travels
/// with the work and is released when the thread ends.
async fn start_claimed_handoff(
    app: &tauri::AppHandle,
    slot: HandoffSlot,
    claimed_job: Value,
    node_key: String,
) -> Result<String, String> {
    let claimed_job_id = handoff_id(&claimed_job)?;

    // A claim without a source is useless to this station, and handing it back
    // as failed tells the library, rather than leaving it leased until expiry.
    if trim_string(claimed_job.get("sourceDownloadUrl")).is_none() {
        // Awaited rather than blocked on: this runs inside the async runtime,
        // and blocking on it from here would panic.
        let settings = load_settings_from_state(&app.state::<AppState>())?;
        let message = "The library handed over this recording without a download link.";
        let _ = mark_handoff_failed(&settings, &claimed_job_id, &node_key, message).await;
        return Err(message.to_string());
    }

    let state = app.state::<AppState>();
    upsert_handoff_job(&state, claimed_job.clone())?;
    emit_handoff_update(app);

    let worker_app = app.clone();
    std::thread::spawn(move || {
        let _slot = slot;
        process_live_handoff_job(worker_app, claimed_job, node_key);
    });

    Ok(claimed_job_id)
}

/// Refreshes the cached queue from the library and tells the window.
async fn refresh_handoff_jobs(
    app: &tauri::AppHandle,
    settings: &Value,
) -> Result<Vec<Value>, String> {
    let response = call_convex_query(
        settings,
        LIVE_HANDOFF_LIST_RECENT_QUERY,
        json!({ "limit": 25 }),
    )
    .await
    .map_err(|error| plain_handoff_error(&error))?;

    let state = app.state::<AppState>();
    let fresh = normalize_handoff_jobs(response);

    // The station's own in-flight job is ahead of the library by up to a
    // progress call, so its local copy wins until the library catches up.
    let running_locally = state.live_handoff_running.load(Ordering::SeqCst);
    let merged = if running_locally {
        let cached = cached_handoff_jobs(&state)?;
        fresh
            .into_iter()
            .map(|job| {
                let id = handoff_id(&job).ok();
                cached
                    .iter()
                    .find(|local| handoff_id(local).ok() == id)
                    .filter(|local| {
                        matches!(
                            local.get("status").and_then(Value::as_str),
                            Some(
                                "claimed"
                                    | "downloading"
                                    | "processing"
                                    | "uploading"
                                    | "registering"
                            )
                        )
                    })
                    .cloned()
                    .unwrap_or(job)
            })
            .collect()
    } else {
        fresh
    };

    let jobs = set_handoff_jobs(&state, merged)?;
    emit_handoff_update(app);
    Ok(jobs)
}

/// Claims whatever is next in the queue. `Ok(None)` means nothing was waiting.
async fn claim_next_handoff(
    app: &tauri::AppHandle,
    settings: &Value,
) -> Result<Option<String>, String> {
    handoff_claim_preconditions(settings)?;
    let state = app.state::<AppState>();
    let slot = take_handoff_slot(&state)?;
    let node_key = desktop_node_key()?;

    let response = call_convex_mutation(
        settings,
        LIVE_HANDOFF_CLAIM_MUTATION,
        json!({ "nodeKey": node_key.clone() }),
    )
    .await
    .map_err(|error| plain_handoff_error(&error))?;

    let Some(claimed_job) = claimed_handoff_job(response) else {
        return Ok(None);
    };

    start_claimed_handoff(app, slot, claimed_job, node_key)
        .await
        .map(Some)
}

#[tauri::command]
async fn wake_live_stream_handoff_worker(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;

    match claim_next_handoff(&app, &settings).await? {
        Some(claimed_job_id) => Ok(json!({
            "woke": true,
            "claimedJobId": claimed_job_id,
            "message": "Picked up a recording. Converting it now."
        })),
        None => Ok(json!({
            "woke": true,
            "claimedJobId": null,
            "message": "Nothing is waiting to be converted."
        })),
    }
}

/// Converts one recording the operator chose, rather than whatever is next.
#[tauri::command]
async fn convert_live_stream_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    handoff_job_id: String,
) -> Result<Value, String> {
    let settings = load_settings_from_state(&state)?;
    handoff_claim_preconditions(&settings)?;

    let handoff_job_id = handoff_job_id.trim().to_string();
    if handoff_job_id.is_empty() {
        return Err("Choose a recording to convert.".to_string());
    }

    let slot = take_handoff_slot(&state)?;
    let node_key = desktop_node_key()?;

    let response = call_convex_mutation(
        &settings,
        LIVE_HANDOFF_CLAIM_BY_ID_MUTATION,
        json!({
            "handoffJobId": handoff_job_id,
            "nodeKey": node_key.clone(),
        }),
    )
    .await
    .map_err(|error| plain_handoff_error(&error))?;

    let claimed_job = claimed_handoff_job(response)
        .ok_or_else(|| "That recording is no longer waiting to be converted.".to_string())?;
    let claimed_job_id = start_claimed_handoff(&app, slot, claimed_job, node_key).await?;

    Ok(json!({
        "woke": true,
        "claimedJobId": claimed_job_id,
        "message": "Converting this recording now."
    }))
}

/// Keeps the queue on screen current and, when this station is set to, takes
/// recordings without anyone pressing a button.
///
/// Runs for the life of the app. Errors are logged when they change rather
/// than every minute, so a library without the handoff functions says so once
/// instead of filling the log.
fn live_handoff_loop(app: tauri::AppHandle) {
    let mut last_error: Option<String> = None;

    loop {
        let state = app.state::<AppState>();
        let settings = settings_snapshot_from_state(&state).ok();

        if let Some(settings) = settings.filter(convex_is_configured) {
            let outcome = tauri::async_runtime::block_on(async {
                refresh_handoff_jobs(&app, &settings).await?;

                let auto_convert =
                    bool_setting(&settings, &["liveRecordings", "autoConvert"], false);
                let idle = !state.live_handoff_running.load(Ordering::SeqCst);
                if auto_convert && idle && storage_is_configured(&settings) {
                    if let Some(claimed_job_id) = claim_next_handoff(&app, &settings).await? {
                        let _ = append_log(
                            &state,
                            "info",
                            "live-handoff",
                            "Picked up a live recording automatically.",
                            Some(claimed_job_id),
                        );
                    }
                }
                Ok::<(), String>(())
            });

            match outcome {
                Ok(()) => last_error = None,
                Err(error) if last_error.as_deref() != Some(error.as_str()) => {
                    let _ = append_log(&state, "warn", "live-handoff", error.clone(), None);
                    last_error = Some(error);
                }
                Err(_) => {}
            }
        }

        thread::sleep(Duration::from_secs(LIVE_HANDOFF_POLL_SECONDS));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = read_settings_file_without_secrets().unwrap_or_else(|error| {
        eprintln!("Could not load saved settings: {error}");
        default_settings()
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            jobs: Mutex::new(Vec::new()),
            logs: Mutex::new(Vec::new()),
            live_handoff_jobs: Mutex::new(Vec::new()),
            media_proxy_origin: Mutex::new(None),
            offload_task: Mutex::new(None),
            offload_running: Arc::new(AtomicBool::new(false)),
            live_handoff_running: Arc::new(AtomicBool::new(false)),
            stream_transfers: Mutex::new(Vec::new()),
            stream_transfer_cancels: Mutex::new(HashMap::new()),
            offload_pause: Arc::new(AtomicBool::new(false)),
            offload_cancel: Arc::new(AtomicBool::new(false)),
            watching: Arc::new(AtomicBool::new(false)),
            pending_update: Mutex::new(None),
            auth_session: Mutex::new(None),
            app_update: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            load_startup_settings,
            load_settings,
            save_settings,
            import_connection_profile,
            export_connection_profile,
            check_for_app_updates,
            install_app_update,
            start_watching,
            stop_watching,
            browse_directory,
            choose_manual_intake_source,
            enqueue_manual_intake,
            retry_job,
            audit_job_uploads,
            resume_job_uploads,
            cleanup_job_uploads,
            refresh_system,
            list_stored_videos,
            update_stored_video_metadata,
            delete_stored_video,
            repair_stored_video_urls,
            generate_stored_video_poster_candidates,
            apply_stored_video_poster,
            get_archive_preview_url,
            retrieve_archived_master,
            choose_trim_source,
            trim_clip,
            list_clips_for_video,
            choose_offload_source,
            get_offload_task,
            run_offload_task,
            pause_offload_task,
            cancel_offload_task,
            get_storage_usage,
            list_live_stream_handoff_jobs,
            wake_live_stream_handoff_worker,
            convert_live_stream_recording,
            list_stream_recordings,
            list_archived_stream_uids,
            archive_stream_recording,
            download_stream_recording,
            cancel_stream_transfer,
            list_stream_transfers,
            dismiss_stream_transfer,
            auth_status,
            auth_sign_in,
            auth_sign_out,
            auth_get_token
        ])
        .setup(|app| {
            // Check once shortly after launch, then on the operator's interval.
            // The first check is delayed so it does not compete with the window
            // opening and the first state read.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;

                loop {
                    let interval_minutes = {
                        let state = handle.state::<AppState>();
                        let settings = settings_snapshot_from_state(&state)
                            .unwrap_or_else(|_| default_settings());
                        let enabled = bool_setting(&settings, &["appUpdates", "enabled"], false);

                        if enabled {
                            if let Ok(snapshot) = check_for_update(&handle).await {
                                if let Ok(mut app_update) = state.app_update.lock() {
                                    *app_update = Some(snapshot);
                                }
                                emit_state_update(&handle);
                            }
                        }

                        number_setting(&settings, &["appUpdates", "checkIntervalMinutes"], 60.0)
                            .max(15.0) as u64
                    };

                    tokio::time::sleep(Duration::from_secs(interval_minutes * 60)).await;
                }
            });

            // Storage credentials are refreshed for the life of the app, so a
            // transfer never waits on the broker.
            let credential_handle = app.handle().clone();
            thread::spawn(move || {
                credential_refresh_loop(credential_handle);
            });

            // Retries run for the life of the app, whether or not watching is on:
            // a job that failed overnight should still get its next attempt.
            let retry_handle = app.handle().clone();
            thread::spawn(move || {
                job_retry_loop(retry_handle);
            });

            // The live recording queue is kept current for the life of the app,
            // and converted from automatically when this station is set to.
            let handoff_handle = app.handle().clone();
            thread::spawn(move || {
                live_handoff_loop(handoff_handle);
            });

            // Start watching on launch when the operator asked for that.
            let watch_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = watch_handle.state::<AppState>();
                let Ok(settings) = settings_snapshot_from_state(&state) else {
                    return;
                };

                if !bool_setting(&settings, &["autoWatch"], true) {
                    return;
                }
                if string_setting(&settings, &["watchFolder"])
                    .trim()
                    .is_empty()
                {
                    return;
                }
                if state.watching.swap(true, Ordering::SeqCst) {
                    return;
                }

                let _ = append_log(
                    &state,
                    "info",
                    "watcher",
                    format!(
                        "Watching {} for new videos.",
                        string_setting(&settings, &["watchFolder"]).trim()
                    ),
                    None,
                );
                emit_state_update(&watch_handle);

                let watching = Arc::clone(&state.watching);
                let loop_handle = watch_handle.clone();
                thread::spawn(move || {
                    watch_folder_loop(loop_handle, watching);
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Media Bridge Tauri host");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS publishes the intermediate values for its SigV4 examples, so the
    /// two halves of the signer are each checked against a documented anchor
    /// rather than against a number this code produced. The canonical request
    /// is the half most likely to drift; the key derivation is the half most
    /// likely to be subtly wrong.
    #[test]
    fn sigv4_canonical_request_matches_the_aws_reference_vector() {
        let amz_date = "20130524T000000Z";
        let credential_scope = "20130524/us-east-1/s3/aws4_request";
        let canonical_query_string = [
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
            (
                "X-Amz-Credential",
                format!("AKIAIOSFODNN7EXAMPLE/{credential_scope}"),
            ),
            ("X-Amz-Date", amz_date.to_string()),
            ("X-Amz-Expires", "86400".to_string()),
            ("X-Amz-SignedHeaders", "host".to_string()),
        ]
        .into_iter()
        .map(|(key, value)| format!("{}={}", uri_encode_segment(key), uri_encode_segment(&value)))
        .collect::<Vec<_>>()
        .join("&");

        let canonical_request = format!(
            "GET\n/test.txt\n{canonical_query_string}\nhost:examplebucket.s3.amazonaws.com\n\nhost\nUNSIGNED-PAYLOAD"
        );

        assert_eq!(
            sha256_hex(&canonical_request),
            "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04"
        );
    }

    #[test]
    fn sigv4_signing_key_matches_the_aws_reference_vector() {
        let date_key = hmac_sha256(b"AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215");
        let region_key = hmac_sha256(&date_key, "us-east-1");
        let service_key = hmac_sha256(&region_key, "iam");
        let signing_key = hmac_sha256(&service_key, "aws4_request");

        assert_eq!(
            hex_encode(&signing_key),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    /// Slashes separate segments and must not be escaped; everything else in a
    /// key has to be, or the signature covers a different path than the URL.
    #[test]
    fn object_keys_encode_per_segment() {
        let encoded = "masters/conference 2026/final+cut.mov"
            .split('/')
            .map(uri_encode_segment)
            .collect::<Vec<_>>()
            .join("/");

        assert_eq!(encoded, "masters/conference%202026/final%2Bcut.mov");
    }

    #[test]
    fn b2_endpoints_yield_their_region() {
        assert_eq!(
            parse_b2_endpoint("https://s3.us-west-004.backblazeb2.com/"),
            Some((
                "https://s3.us-west-004.backblazeb2.com".to_string(),
                "us-west-004".to_string()
            ))
        );
        assert_eq!(parse_b2_endpoint("https://s3.amazonaws.com"), None);
        assert_eq!(parse_b2_endpoint(""), None);
    }

    /// Canonical assets keep posters in their own prefix so an R2 lifecycle
    /// rule can expire social renders without touching published artwork.
    #[test]
    fn poster_keys_follow_the_storage_layout() {
        assert_eq!(
            resolve_poster_object_key("videos/abc123/"),
            "posters/abc123/default.jpg"
        );
        assert_eq!(
            resolve_poster_object_key("streaming/vod/abc123/"),
            "posters/abc123/default.jpg"
        );
        assert_eq!(
            resolve_poster_object_key("vod/hls/legacy-job"),
            "vod/hls/legacy-job/poster.jpg"
        );
    }

    #[test]
    fn canonical_storage_keys_use_the_videos_prefix() {
        let settings = json!({ "storage": { "layout": "canonical" } });
        let job = json!({
            "id": "job_123456789",
            "sourceName": "Game Recap.mov",
            "sourcePath": "/tmp/Game Recap.mov",
            "projectName": "Centex Sports",
            "recordedAt": "2026-09-15T19:30:00Z",
        });
        let plan = build_storage_key_plan(
            &settings,
            &job,
            "sha256:a1b2c3d4e5f607189999aaaabbbbccccddddeeeeffff00001111222233334444",
        );

        assert_eq!(plan["assetKey"], "a1b2c3d4e5f60718");
        assert_eq!(plan["distributionObjectKey"], "videos/a1b2c3d4e5f60718");
        assert_eq!(
            plan["posterObjectKey"],
            "posters/a1b2c3d4e5f60718/default.jpg"
        );
        assert_eq!(
            plan["archiveObjectKey"],
            "masters/centex-sports/2026-09-15/a1b2c3d4e5f60718/Game_Recap.mov"
        );
    }

    #[test]
    fn dash_manifest_uses_named_video_rendition_paths() {
        let output_directory = std::env::temp_dir().join(create_id("csn-dash-manifest-test", 1));
        let reference_playlist_directory = output_directory.join("video").join("1080p_6000k");
        fs::create_dir_all(&reference_playlist_directory).unwrap();
        fs::write(
            reference_playlist_directory.join("stream.m3u8"),
            "#EXTM3U\n#EXTINF:2.000,\nchunk_00001.m4s\n#EXTINF:2.000,\nchunk_00002.m4s\n",
        )
        .unwrap();

        let manifest_path = write_dash_manifest(&output_directory, 4.0, true).unwrap();
        let manifest = fs::read_to_string(manifest_path).unwrap();
        let _ = fs::remove_dir_all(output_directory);

        assert!(manifest.contains("id=\"1080p_6000k\""), "{manifest}");
        assert!(
            manifest.contains("initialization=\"video/$RepresentationID$/init.mp4\""),
            "{manifest}"
        );
        assert!(
            manifest.contains("media=\"video/$RepresentationID$/chunk_$Number%05d$.m4s\""),
            "{manifest}"
        );
        assert!(manifest.contains("startNumber=\"1\""), "{manifest}");
    }

    /// A record states its delivery type when it knows it, and is read from its
    /// URLs and sources when it does not.
    #[test]
    fn delivery_type_is_inferred_the_way_the_renderer_infers_it() {
        assert_eq!(
            infer_stored_delivery_type(&json!({ "deliveryType": "hls" })),
            "hls"
        );
        assert_eq!(
            infer_stored_delivery_type(&json!({ "playbackUrl": "https://cdn/x/master.m3u8" })),
            "hls"
        );
        assert_eq!(
            infer_stored_delivery_type(&json!({ "sources": [{ "codec": "h264" }] })),
            "progressive"
        );
        assert_eq!(infer_stored_delivery_type(&json!({})), "progressive");
    }

    /// Four frames, never in the first or last quarter-second — the head and
    /// tail of a recording are usually black.
    #[test]
    fn poster_candidates_stay_inside_the_video() {
        let times = poster_candidate_times(100.0);
        assert_eq!(times.len(), 4);
        assert!(times.iter().all(|time| *time >= 0.25 && *time <= 99.75));
        assert!(times.windows(2).all(|pair| pair[0] < pair[1]));

        // A video too short to space four frames across collapses to fewer.
        assert!(poster_candidate_times(0.0).iter().all(|time| *time >= 0.25));
    }

    /// The setting picks the encoder; "Automatic" defers to the platform.
    #[test]
    fn the_encoder_setting_wins_over_the_platform_default() {
        assert_eq!(
            effective_encoder(&json!({ "hardwareEncoderOverride": "nvenc" })),
            "nvenc"
        );
        assert_eq!(
            effective_encoder(&json!({ "hardwareEncoderOverride": "videotoolbox" })),
            "videotoolbox"
        );
        assert_eq!(
            effective_encoder(&json!({ "hardwareEncoderOverride": "software" })),
            "software"
        );

        let automatic = effective_encoder(&json!({ "hardwareEncoderOverride": "auto" }));
        assert_eq!(
            automatic,
            if cfg!(target_os = "windows") {
                "nvenc"
            } else if cfg!(target_os = "macos") {
                "videotoolbox"
            } else {
                "software"
            }
        );
    }

    /// Hardware encoders have no CRF equivalent, so progressive output has to
    /// switch to a rate target rather than reuse the software options.
    #[test]
    fn each_encoder_gets_options_it_understands() {
        let software = progressive_video_options("software");
        assert!(software.contains(&"libx264".to_string()));
        assert!(software.contains(&"-crf".to_string()));

        let videotoolbox = progressive_video_options("videotoolbox");
        assert!(videotoolbox.contains(&"h264_videotoolbox".to_string()));
        assert!(!videotoolbox.contains(&"-crf".to_string()));
        assert!(videotoolbox.contains(&"-b:v".to_string()));

        let nvenc = progressive_video_options("nvenc");
        assert!(nvenc.contains(&"h264_nvenc".to_string()));
        assert!(!nvenc.contains(&"-crf".to_string()));

        // The HLS ladder sets its own per-rung bitrate, so these must not.
        for encoder in ["software", "videotoolbox", "nvenc"] {
            let options = hls_video_options(encoder);
            assert!(
                !options.contains(&"-b:v".to_string()),
                "{encoder} set a bitrate"
            );
            assert!(
                !options.contains(&"-crf".to_string()),
                "{encoder} set a CRF"
            );
        }

        // CUDA decode only makes sense on the NVIDIA path.
        assert_eq!(encoder_input_options("nvenc"), vec!["-hwaccel", "cuda"]);
        assert!(encoder_input_options("videotoolbox").is_empty());
        assert!(encoder_input_options("software").is_empty());
    }

    /// Only failures that look like the GPU giving out are worth retrying in
    /// software — a missing input file will not encode any better.
    #[test]
    fn only_hardware_failures_trigger_the_software_retry() {
        assert!(is_hardware_acceleration_failure(
            "Error while opening encoder - h264_videotoolbox"
        ));
        assert!(is_hardware_acceleration_failure("CUDA_ERROR_OUT_OF_MEMORY"));
        assert!(!is_hardware_acceleration_failure(
            "No such file or directory"
        ));
    }

    /// RFC 7636 Appendix B's published vector. PKCE is what stands in for a
    /// client secret in this app, so a wrong challenge means every sign-in
    /// fails at the token exchange with nothing useful in the message.
    /// Identity falls back to the access token's own claims when the userinfo
    /// endpoint is not available to the granted scopes.
    #[test]
    fn access_token_claims_are_readable_without_verification() {
        // header.payload.signature, payload base64url with no padding.
        let payload = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            br#"{"sub":"user_123","org_id":"org_456","email":"maya@example.com"}"#,
        );
        let token = format!("aGVhZGVy.{payload}.c2ln");

        let claims = access_token_claims(&token).expect("claims should decode");
        assert_eq!(claims["sub"], "user_123");
        assert_eq!(claims["org_id"], "org_456");

        assert!(access_token_claims("not-a-jwt").is_none());
        assert!(access_token_claims("only.two").is_none());
    }

    /// `openid` is not requested: the client is not always allowed it, and
    /// asking for a disallowed scope fails the entire sign-in.
    #[test]
    fn requested_scopes_stay_within_what_an_oauth_client_is_granted() {
        assert!(!AUTH_SCOPES.split(' ').any(|scope| scope == "openid"));
        for required in ["profile", "email", "offline_access", "user:org:read"] {
            assert!(
                AUTH_SCOPES.split(' ').any(|scope| scope == required),
                "{required} must be requested"
            );
        }
    }

    /// Proves what the token request actually looks like on the wire.
    ///
    /// OAuth token endpoints reject a JSON body — the spec requires form
    /// encoding — and that failure surfaces as a generic client error with no
    /// hint about the cause, so it is worth pinning rather than assuming.
    #[tokio::test]
    async fn the_token_request_is_form_encoded_with_the_pkce_verifier() {
        use std::io::{BufRead, BufReader, Read, Write};

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let port = listener.local_addr().unwrap().port();

        let captured = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut head = String::new();
            let mut content_length = 0_usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                head.push_str(&line);
            }

            let mut body = vec![0_u8; content_length];
            reader.read_exact(&mut body).unwrap();

            let payload = r#"{"access_token":"a","refresh_token":"r","expires_in":60}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();

            (head, String::from_utf8_lossy(&body).to_string())
        });

        let tokens = exchange_authorization_code(
            &format!("http://127.0.0.1:{port}"),
            "client-abc",
            "the-code",
            "the-verifier",
            "http://127.0.0.1:4517/callback",
        )
        .await
        .expect("exchange should succeed");

        let (head, body) = captured.join().unwrap();
        let head = head.to_ascii_lowercase();

        assert!(
            head.contains("content-type: application/x-www-form-urlencoded"),
            "token request must be form encoded, got headers:\n{head}"
        );
        assert!(
            !head.contains("application/json"),
            "must not send a JSON body"
        );

        // Every parameter PKCE needs, and no client secret.
        assert!(
            body.contains("grant_type=authorization_code"),
            "body: {body}"
        );
        assert!(body.contains("code=the-code"), "body: {body}");
        assert!(body.contains("code_verifier=the-verifier"), "body: {body}");
        assert!(body.contains("client_id=client-abc"), "body: {body}");
        assert!(
            !body.contains("client_secret"),
            "a public client must never send a secret: {body}"
        );

        assert_eq!(tokens["access_token"], "a");
    }

    /// An offline station must keep its session. Being unable to ask whether a
    /// session is still valid is not the same as being told it is not, and a
    /// station in a truck would otherwise lock itself out of screens that need
    /// no network at all.
    #[test]
    fn only_a_refusal_ends_a_session_not_an_unreachable_service() {
        let ends_session =
            |failure: &RefreshFailure| matches!(failure, RefreshFailure::Rejected(_));

        assert!(!ends_session(&RefreshFailure::Unreachable(
            "dns failed".into()
        )));
        assert!(ends_session(&RefreshFailure::Rejected("expired".into())));
    }

    /// Only failures that might clear on their own get retried. Retrying the
    /// rest would bury a real problem under a queue that looks busy.
    #[test]
    fn only_failures_that_might_clear_are_retried() {
        for transient in [
            "rclone: corrupted on transfer, retries exhausted",
            "Could not reach Convex: connection closed",
            "operation timed out",
            "HTTP 503 Service Unavailable",
            "dns error: failed to lookup address",
        ] {
            assert!(is_transient_failure(transient), "should retry: {transient}");
        }

        for permanent in [
            "No such file or directory",
            "moov atom not found",
            "permission denied",
            "Convex HTTP 403 Forbidden: unauthorized",
            "season_opener.mov did not copy cleanly",
            "no space left on device",
        ] {
            assert!(
                !is_transient_failure(permanent),
                "should not retry: {permanent}"
            );
        }
    }

    /// A permanent failure that happens to mention a network word must still
    /// stop and ask for a person.
    #[test]
    fn permanent_wins_over_a_coincidental_network_word() {
        assert!(!is_transient_failure(
            "permission denied opening the network share"
        ));
        assert!(!is_transient_failure("unauthorized: connection rejected"));
    }

    /// Backoff grows and then holds, so an overnight outage does not hammer a
    /// service that is already struggling.
    #[test]
    fn retry_backoff_grows_then_settles() {
        let delays: Vec<u64> = (0..JOB_RETRY_BACKOFF_SECONDS.len())
            .map(retry_delay_seconds)
            .collect();

        assert!(
            delays.windows(2).all(|pair| pair[0] < pair[1]),
            "{delays:?}"
        );
        // Past the end it holds at the longest wait rather than growing forever.
        assert_eq!(
            retry_delay_seconds(99),
            *JOB_RETRY_BACKOFF_SECONDS.last().unwrap()
        );
    }

    #[test]
    fn retry_waits_are_described_in_plain_words() {
        assert_eq!(retry_wait_label(30), "in under a minute");
        assert_eq!(retry_wait_label(120), "in about 2 minutes");
        assert_eq!(retry_wait_label(60), "in under a minute");
        assert_eq!(retry_wait_label(1800), "in about 30 minutes");
    }

    /// A client's recording must be owned by the client. The station never
    /// names an owner — it names the job, and the library reads the owner off
    /// its own record. Ordinary ingest must not grow the fields, or a backend
    /// that predates them would reject every upload.
    #[test]
    fn only_handoff_recordings_tell_the_library_which_job_they_came_from() {
        let finished = json!({
            "sourceName": "game.mp4",
            "archiveObjectKey": "masters/x/2026-09-13/abc/game.mp4",
            "distributionObjectKey": "videos/abc",
            "publicUrl": "https://media.example/videos/abc/master.m3u8",
        });

        let ordinary = build_convex_payload(&finished, "ready").unwrap();
        assert!(ordinary.get("liveHandoffJobId").is_none(), "{ordinary}");
        assert!(ordinary.get("nodeKey").is_none(), "{ordinary}");
        assert!(ordinary.get("ownerOrgId").is_none(), "{ordinary}");

        let mut from_handoff = finished.clone();
        from_handoff["sourceHandoffJobId"] = json!("job_123");
        from_handoff["handoffNodeKey"] = json!("tauri-node-1");

        let handoff = build_convex_payload(&from_handoff, "ready").unwrap();
        assert_eq!(handoff["liveHandoffJobId"], "job_123");
        assert_eq!(handoff["nodeKey"], "tauri-node-1");
        // Never the owner itself: that would let a station claim any tenant.
        assert!(handoff.get("ownerOrgId").is_none(), "{handoff}");
        assert!(handoff.get("ownerOrgSlug").is_none(), "{handoff}");
    }

    #[test]
    fn only_real_stream_uids_reach_an_object_key() {
        assert!(is_stream_uid("ea95132c15732412d22c1476fa83f27a"));
        assert!(!is_stream_uid("09d9fcf20d5272c4"), "an ingest asset folder");
        assert!(!is_stream_uid("../../masters/other-client/x/y/zz"));
        assert!(!is_stream_uid(""));
    }

    #[test]
    fn stream_archives_are_grouped_by_client_and_found_by_uid() {
        let keys = stream_archive_keys(
            "EA95132C15732412D22C1476FA83F27A",
            Some("Temple vs. Belton — Game 1"),
            Some("MCC Athletics"),
            Some("2026-09-12T23:10:00Z"),
        );
        assert_eq!(
            keys.video,
            "masters/mcc-athletics/2026-09-12/ea95132c15732412d22c1476fa83f27a/temple-vs-belton-game-1.mp4"
        );
        assert!(keys.sidecar.ends_with("/temple-vs-belton-game-1.json"));

        let unassigned = stream_archive_keys(
            "ea95132c15732412d22c1476fa83f27a",
            None,
            None,
            Some("2026-09-12"),
        );
        assert!(
            unassigned
                .video
                .starts_with("masters/unassigned/2026-09-12/"),
            "{}",
            unassigned.video
        );

        // Paths are relative to masters/, as lsjson reports them.
        let listing = json!([
            { "Path": "mcc-athletics/2026-09-12/ea95132c15732412d22c1476fa83f27a/temple-vs-belton-game-1.mp4" },
            { "Path": "mcc-athletics/2026-09-12/ea95132c15732412d22c1476fa83f27a/temple-vs-belton-game-1.json" },
            { "Path": "mcc-volleyball/2026-09-12/09d9fcf20d5272c4/MCC_Volleyball.mp4" },
            { "Path": "loose.mp4" },
        ]);
        assert_eq!(
            archived_stream_uids(&listing),
            vec!["ea95132c15732412d22c1476fa83f27a".to_string()]
        );
    }

    #[test]
    fn live_recordings_are_retried_by_the_queue_not_by_the_station() {
        assert!(retries_locally(&json!({ "intakeMode": "watch_folder" })));
        assert!(retries_locally(&json!({})));
        assert!(!retries_locally(&json!({ "intakeMode": "live_handoff" })));
    }

    #[test]
    fn a_library_without_live_recordings_says_so_plainly() {
        let missing = plain_handoff_error(
            "Could not find public function for 'media/liveStream:listRecentHandoffJobs'. Did you forget to run `npx convex dev`?",
        );
        assert!(
            missing.contains("does not support live recordings yet"),
            "{missing}"
        );
        assert!(!missing.contains("npx convex"), "{missing}");

        // Anything else is the library's own words, untouched.
        assert_eq!(
            plain_handoff_error("Another station is already converting this recording."),
            "Another station is already converting this recording."
        );
    }

    #[test]
    fn stations_do_not_convert_live_recordings_until_asked() {
        assert!(!bool_setting(
            &default_settings(),
            &["liveRecordings", "autoConvert"],
            true
        ));
    }

    /// Storage credentials are scoped to object prefixes, so any bucket-level
    /// operation comes back refused. rclone checking for the bucket and then
    /// creating it is exactly such an operation, and it failed every upload
    /// with a 403 that looked like bad credentials.
    ///
    /// Reads the credential cache without writing it, so it cannot disturb the
    /// test below.
    #[test]
    fn rclone_never_tries_to_create_a_bucket() {
        let config = rclone_config(&json!({
            "b2": { "keyId": "id", "applicationKey": "key" },
            "r2": { "accessKeyId": "id", "secretAccessKey": "secret", "accountId": "acct" },
        }));

        assert_eq!(
            config.matches("no_check_bucket = true").count(),
            2,
            "{config}"
        );
    }

    /// The credential cache is a process global, so these scenarios share state
    /// and run as one test rather than three that could interleave.
    #[test]
    fn rclone_prefers_brokered_credentials_and_falls_back_to_local_keys() {
        let settings = json!({
            "b2": { "keyId": "local-b2-id", "applicationKey": "local-b2-key" },
            "r2": {
                "accessKeyId": "local-r2-id",
                "secretAccessKey": "local-r2-secret",
                "accountId": "acct",
            },
        });

        // 1. Nothing cached: a station whose broker is unreachable keeps working
        //    on the keys in Settings.
        store_brokered_credentials(None);
        let config = rclone_config(&settings);
        assert!(config.contains("account = local-b2-id"), "{config}");
        assert!(config.contains("access_key_id = local-r2-id"), "{config}");
        // Long-lived keys carry no session token, and emitting an empty one
        // would make rclone sign requests R2 rejects.
        assert!(!config.contains("session_token"), "{config}");

        // 2. A live brokered set wins, and the R2 session token travels with it.
        store_brokered_credentials(Some(json!({
            "expiresAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            "b2": { "keyId": "temp-b2-id", "applicationKey": "temp-b2-key" },
            "r2": {
                "accessKeyId": "temp-r2-id",
                "secretAccessKey": "temp-r2-secret",
                "sessionToken": "temp-session",
            },
        })));
        let config = rclone_config(&settings);
        assert!(config.contains("account = temp-b2-id"), "{config}");
        assert!(config.contains("session_token = temp-session"), "{config}");
        assert!(!config.contains("local-b2-id"), "{config}");
        assert!(!config.contains("local-r2-secret"), "{config}");

        // 3. An expired set is ignored rather than handed to rclone after a
        //    long idle period, and the local keys take over again.
        store_brokered_credentials(Some(json!({
            "expiresAt": (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339(),
            "r2": { "accessKeyId": "stale" },
        })));
        assert!(current_brokered_credentials().is_none());
        let config = rclone_config(&settings);
        assert!(config.contains("access_key_id = local-r2-id"), "{config}");
        assert!(!config.contains("stale"), "{config}");

        store_brokered_credentials(None);
    }

    #[test]
    fn settings_secrets_are_redacted_for_disk_and_hydrated_from_secure_storage() {
        test_keychain().lock().unwrap().clear();
        let settings = normalize_settings_value(json!({
            "b2": { "keyId": "b2-id", "applicationKey": "b2-secret" },
            "r2": {
                "accessKeyId": "r2-id",
                "secretAccessKey": "r2-secret",
            },
            "convex": { "nodeToken": "library-token" },
            "broker": { "token": "station-token" },
        }));

        store_settings_secrets(&settings).unwrap();
        let redacted = redact_secret_settings(settings.clone());

        for (path, _) in SECRET_SETTING_PATHS {
            assert_eq!(string_setting(&redacted, path), "");
        }
        assert_eq!(
            string_setting(
                &hydrate_settings_secrets(redacted).unwrap(),
                &["b2", "keyId"]
            ),
            "b2-id"
        );
        assert_eq!(
            string_setting(
                &hydrate_settings_secrets(settings.clone()).unwrap(),
                &["broker", "token"]
            ),
            "station-token"
        );
    }

    #[test]
    fn clearing_a_secret_removes_it_from_secure_storage() {
        test_keychain().lock().unwrap().clear();
        let with_secret = normalize_settings_value(json!({
            "broker": { "token": "station-token" },
        }));
        store_settings_secrets(&with_secret).unwrap();
        assert_eq!(
            secure_read_secret("settings.broker.token")
                .unwrap()
                .as_deref(),
            Some("station-token")
        );

        let cleared = normalize_settings_value(json!({
            "broker": { "token": "" },
        }));
        store_settings_secrets(&cleared).unwrap();
        assert!(secure_read_secret("settings.broker.token")
            .unwrap()
            .is_none());
    }

    /// Credentials must never be attached to a URL that is not the broker's own
    /// media route — the whole point of the proxy is that it fetches arbitrary
    /// remote media.
    /// The storyboard has to line up with the video or the previews show the
    /// wrong moment, so the cadence, the tiling and the timestamps are pinned.
    #[test]
    fn a_storyboard_describes_the_whole_video() {
        // A short clip samples at the target cadence.
        assert_eq!(thumbnail_interval_seconds(60.0), 5.0);
        assert_eq!(thumbnail_tile_count(60.0, 5.0), 12);

        // A long recording stretches the cadence rather than producing a
        // storyboard bigger than the video it describes.
        let long = 4.0 * 3600.0;
        let interval = thumbnail_interval_seconds(long);
        assert!(interval > 5.0, "a four-hour video must stretch its cadence");
        assert!(thumbnail_tile_count(long, interval) <= THUMBNAIL_MAX_TILES);

        let vtt = build_thumbnail_vtt(60.0, 5.0, 12);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        // First tile: top-left of the first sheet, starting at zero.
        assert!(vtt.contains("00:00:00.000 --> 00:00:05.000\nsprite_001.jpg#xywh=0,0,160,90"));
        // Second tile moves one column across, not one row down.
        assert!(vtt.contains("sprite_001.jpg#xywh=160,0,160,90"), "{vtt}");
        // The sixth wraps to the next row.
        assert!(vtt.contains("sprite_001.jpg#xywh=0,90,160,90"), "{vtt}");
        // Every tile is described exactly once.
        assert_eq!(vtt.matches("#xywh=").count(), 12);
    }

    /// Tile 26 belongs on the second sheet, not off the bottom of the first.
    #[test]
    fn storyboard_tiles_roll_onto_the_next_sheet() {
        let per_sheet = THUMBNAIL_GRID_COLUMNS * THUMBNAIL_GRID_ROWS;
        let vtt = build_thumbnail_vtt(5.0 * (per_sheet + 1) as f64, 5.0, per_sheet + 1);

        assert!(vtt.contains("sprite_002.jpg#xywh=0,0,160,90"), "{vtt}");
        assert_eq!(vtt.matches("sprite_001.jpg").count(), per_sheet as usize);
        assert_eq!(vtt.matches("sprite_002.jpg").count(), 1);
    }

    #[test]
    fn vtt_timestamps_are_hours_minutes_seconds_millis() {
        assert_eq!(vtt_timestamp(0.0), "00:00:00.000");
        assert_eq!(vtt_timestamp(5.5), "00:00:05.500");
        assert_eq!(vtt_timestamp(3661.25), "01:01:01.250");
        // Negative time is not representable in WebVTT.
        assert_eq!(vtt_timestamp(-4.0), "00:00:00.000");
    }

    #[test]
    fn media_credentials_are_scoped_to_the_brokers_media_route() {
        // A URL elsewhere gets nothing, even when it looks close.
        assert!(broker_media_credentials("https://example.org/media/x.m3u8").is_none());
        assert!(broker_media_credentials("https://cdn.csn.com/videos/a/x.m3u8").is_none());
    }

    /// Playback only reroutes when it is switched on and the broker is set, and
    /// only the public bucket's own URLs are rewritten — anything else is left
    /// alone rather than pointed at a Worker that will not serve it.
    #[test]
    fn playback_reroutes_through_the_broker_only_when_asked() {
        let off = json!({
            "broker": { "url": "https://b.example.com", "token": "t", "streamMedia": false },
            "r2": { "publicBaseUrl": "https://cdn.csn.com" },
        });
        assert_eq!(
            broker_media_url(&off, "https://cdn.csn.com/videos/abc/master.m3u8"),
            None
        );

        let on = json!({
            "broker": { "url": "https://b.example.com", "token": "t", "streamMedia": true },
            "r2": { "publicBaseUrl": "https://cdn.csn.com" },
        });
        assert_eq!(
            broker_media_url(&on, "https://cdn.csn.com/videos/abc/master.m3u8").as_deref(),
            Some("https://b.example.com/media/videos/abc/master.m3u8")
        );

        // A URL from somewhere else is not ours to reroute.
        assert_eq!(broker_media_url(&on, "https://example.org/clip.mp4"), None);
        // The bare base with no object is not a media path.
        assert_eq!(broker_media_url(&on, "https://cdn.csn.com/"), None);

        // Without a token the broker cannot be used at all.
        let no_token = json!({
            "broker": { "url": "https://b.example.com", "token": "", "streamMedia": true },
            "r2": { "publicBaseUrl": "https://cdn.csn.com" },
        });
        assert_eq!(
            broker_media_url(&no_token, "https://cdn.csn.com/videos/abc/master.m3u8"),
            None
        );
    }

    #[test]
    fn the_broker_is_off_until_both_values_are_set() {
        assert!(!broker_is_configured(
            &json!({ "broker": { "url": "", "token": "" } })
        ));
        assert!(!broker_is_configured(
            &json!({ "broker": { "url": "https://broker.example.com", "token": "" } })
        ));
        assert!(broker_is_configured(
            &json!({ "broker": { "url": "https://broker.example.com", "token": "t" } })
        ));
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    /// Verifiers must be unguessable and long enough to be worth hashing.
    #[test]
    fn pkce_verifiers_are_unique_and_url_safe() {
        let first = random_url_token(64);
        let second = random_url_token(64);

        assert_ne!(first, second);
        assert!(first.len() >= 43 && first.len() <= 128);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
    }

    /// The callback query is parsed by hand, so the cases that bite are here:
    /// a key that is a prefix of another, percent escapes, and plus-as-space.
    #[test]
    fn callback_query_values_are_read_exactly() {
        assert_eq!(
            query_value("code=abc123&state=xyz", "code").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            query_value("code=abc123&state=xyz", "state").as_deref(),
            Some("xyz")
        );
        // `code_verifier` must not satisfy a lookup for `code`.
        assert_eq!(
            query_value("code_verifier=wrong&code=right", "code").as_deref(),
            Some("right")
        );
        assert_eq!(
            query_value("code=a%2Bb%2Fc", "code").as_deref(),
            Some("a+b/c")
        );
        assert_eq!(
            query_value("error=access+denied", "error").as_deref(),
            Some("access denied")
        );
        assert_eq!(query_value("code=abc", "state"), None);
    }

    /// Redirect URIs and scopes go into a query string, so the reserved
    /// characters in them have to survive the trip.
    #[test]
    fn query_parameters_are_percent_encoded() {
        assert_eq!(
            percent_encode("http://127.0.0.1:4517/callback"),
            "http%3A%2F%2F127.0.0.1%3A4517%2Fcallback"
        );
        assert_eq!(
            percent_encode("openid profile email user:org:read"),
            "openid%20profile%20email%20user%3Aorg%3Aread"
        );
    }

    /// Every port the callback may land on has to be registered in the Clerk
    /// dashboard, so the set stays small, fixed and known.
    #[test]
    fn callback_ports_are_a_known_fixed_set() {
        assert_eq!(AUTH_CALLBACK_PORTS, &[4517, 4518, 4519]);
    }

    /// A station with no issuer or client id runs ungated, exactly as it did
    /// before sign-in existed.
    #[test]
    fn auth_is_off_until_both_values_are_set() {
        assert!(!auth_is_configured(
            &json!({ "auth": { "issuer": "", "clientId": "" } })
        ));
        assert!(!auth_is_configured(
            &json!({ "auth": { "issuer": "https://clerk.example.com", "clientId": "" } })
        ));
        assert!(auth_is_configured(
            &json!({ "auth": { "issuer": "https://clerk.example.com", "clientId": "abc" } })
        ));
    }

    /// The renderer must never receive a token.
    #[test]
    fn the_public_snapshot_withholds_tokens() {
        let settings =
            json!({ "auth": { "issuer": "https://clerk.example.com", "clientId": "abc" } });
        let session = json!({
            "accessToken": "super-secret",
            "refreshToken": "also-secret",
            "person": { "id": "user_1", "name": "Maya", "email": "maya@example.com" },
            "team": { "id": "org_1", "name": "Team Alpha", "slug": "alpha" },
        });

        let snapshot = auth_public_snapshot(&settings, Some(&session));
        let rendered = snapshot.to_string();

        assert_eq!(snapshot["status"], "signed-in");
        assert_eq!(snapshot["person"]["name"], "Maya");
        assert_eq!(snapshot["team"]["name"], "Team Alpha");
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("also-secret"));
    }

    #[test]
    fn webp_copies_replace_the_image_extension() {
        assert_eq!(
            to_webp_relative_path("DCIM/100/IMG_0042.JPG"),
            "DCIM/100/IMG_0042.webp"
        );
        assert_eq!(to_webp_relative_path("shot.jpeg"), "shot.webp");
        assert_eq!(to_webp_relative_path("clip.mov"), "clip.mov.webp");
    }

    /// Copy dominates the clock, so it dominates the bar; the other phases only
    /// take a share when they are actually going to run.
    #[test]
    fn offload_weights_only_count_phases_that_will_run() {
        assert_eq!(offload_stage_weights(false, false), (100.0, 0.0, 0.0));
        assert_eq!(offload_stage_weights(true, false), (75.0, 25.0, 0.0));
        assert_eq!(offload_stage_weights(false, true), (75.0, 0.0, 25.0));
        assert_eq!(offload_stage_weights(true, true), (60.0, 20.0, 20.0));

        let (copy, convert, upload) = offload_stage_weights(true, true);
        assert_eq!(copy + convert + upload, 100.0);
    }

    #[test]
    fn offload_classifies_camera_files() {
        assert_eq!(offload_file_kind(Path::new("a/IMG_1.JPG")), "image");
        assert_eq!(offload_file_kind(Path::new("a/CLIP.MOV")), "video");
        assert_eq!(offload_file_kind(Path::new("a/notes.txt")), "other");
    }

    /// "Healthy" must never be claimed when there was nothing local to compare
    /// against — that is the difference between a verified upload and a guess.
    /// With nothing on either side there is genuinely nothing to say, which is
    /// what "unknown" is for; a remote object with no local counterpart is
    /// reported as a difference, not as a clean bill of health.
    #[test]
    fn an_audit_without_local_files_is_never_healthy() {
        let nothing_either_side = build_upload_audit_section(
            "Playback package",
            "r2",
            "bucket",
            "videos/abc",
            None,
            false,
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            summarize_upload_audit("game.mov", &[&nothing_either_side]).0,
            "unknown"
        );

        let remote_only = build_upload_audit_section(
            "Playback package",
            "r2",
            "bucket",
            "videos/abc",
            None,
            false,
            Vec::new(),
            vec![json!({ "objectKey": "videos/abc/master.m3u8", "sizeBytes": 12 })],
        );
        assert_eq!(
            summarize_upload_audit("game.mov", &[&remote_only]).0,
            "partial"
        );

        let matching = build_upload_audit_section(
            "Playback package",
            "r2",
            "bucket",
            "videos/abc",
            Some("/tmp/out"),
            true,
            vec![json!({ "objectKey": "videos/abc/master.m3u8", "sizeBytes": 12 })],
            vec![json!({ "objectKey": "videos/abc/master.m3u8", "sizeBytes": 12 })],
        );
        assert_eq!(
            summarize_upload_audit("game.mov", &[&matching]).0,
            "healthy"
        );
    }

    #[test]
    fn an_audit_names_what_is_missing_or_the_wrong_size() {
        let section = build_upload_audit_section(
            "Playback package",
            "r2",
            "bucket",
            "videos/abc",
            Some("/tmp/out"),
            true,
            vec![
                json!({ "objectKey": "videos/abc/master.m3u8", "sizeBytes": 12 }),
                json!({ "objectKey": "videos/abc/video/1080p_6000k/chunk_00001.m4s", "sizeBytes": 900 }),
            ],
            vec![
                json!({ "objectKey": "videos/abc/master.m3u8", "sizeBytes": 7 }),
                json!({ "objectKey": "videos/abc/stray.tmp", "sizeBytes": 1 }),
            ],
        );

        assert_eq!(
            section["missingObjectKeys"],
            json!(["videos/abc/video/1080p_6000k/chunk_00001.m4s"])
        );
        assert_eq!(
            section["sizeMismatchObjectKeys"],
            json!(["videos/abc/master.m3u8"])
        );
        assert_eq!(
            section["unexpectedObjectKeys"],
            json!(["videos/abc/stray.tmp"])
        );
        assert_eq!(summarize_upload_audit("game.mov", &[&section]).0, "partial");
    }

    #[test]
    fn a_missing_object_is_not_a_delete_failure() {
        assert!(is_missing_remote_error("ERROR: object not found"));
        assert!(is_missing_remote_error("directory not found"));
        assert!(!is_missing_remote_error("permission denied"));
    }
}
