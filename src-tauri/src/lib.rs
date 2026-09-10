#![recursion_limit = "256"]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    net::{SocketAddr, TcpStream},
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
}

const APP_CONFIG_DIR_NAME: &str = "CSN Media Bridge";
const SETTINGS_FILE_NAME: &str = "settings.json";
const NODE_KEY_FILE_NAME: &str = "node-key.txt";
const MAX_JOB_HISTORY: usize = 50;
const MAX_LOG_ENTRIES: usize = 200;
const STATE_UPDATED_EVENT: &str = "media-bridge:state-updated";
const LIVE_HANDOFF_UPDATED_EVENT: &str = "media-bridge:live-stream-handoff-updated";
const HLS_SEGMENT_DURATION_SECONDS: u64 = 2;
const DASH_MANIFEST_FILENAME: &str = "manifest.mpd";
const PROGRESSIVE_H264_FILENAME: &str = "playback-h264.mp4";
const MASTERS_PREFIX: &str = "masters";
const STREAMING_PREFIX: &str = "streaming/vod";
const POSTERS_PREFIX: &str = "posters";
const UNASSIGNED_PROJECT_SEGMENT: &str = "unassigned";
const SUPPORTED_INGEST_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];
const LIVE_HANDOFF_LIST_RECENT_QUERY: &str = "media/liveStream:listRecentHandoffJobs";
const LIVE_HANDOFF_CLAIM_MUTATION: &str = "media/liveStream:claimNextHandoffJob";
const LIVE_HANDOFF_RENEW_MUTATION: &str = "media/liveStream:renewHandoffJobLease";
const LIVE_HANDOFF_PROGRESS_MUTATION: &str = "media/liveStream:markHandoffProgress";
const LIVE_HANDOFF_COMPLETE_MUTATION: &str = "media/liveStream:completeHandoffJob";
const LIVE_HANDOFF_FAILED_MUTATION: &str = "media/liveStream:markHandoffFailed";

struct HlsVariant {
    label: &'static str,
    width: u64,
    height: u64,
    bitrate: &'static str,
    maxrate: &'static str,
    bufsize: &'static str,
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
        "offload": {
            "localFolder": "",
            "b2PathPrefix": option_env!("CSN_OFFLOAD_B2_PATH_PREFIX").unwrap_or("offloads"),
            "localCopyMode": "fast"
        },
        "appUpdates": {
            "enabled": false,
            "baseUrl": "",
            "checkIntervalMinutes": 60
        }
    })
}

fn default_state() -> Value {
    build_state(system_snapshot(&default_settings()), Vec::new(), Vec::new())
}

fn build_state(system: Value, jobs: Vec<Value>, logs: Vec<Value>) -> Value {
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
        "isWatching": false,
        "queueDepth": queue_depth,
        "activeEncodingJobId": active_encoding_job_id,
        "jobs": jobs,
        "logs": logs,
        "system": system,
        "appUpdate": {
            "status": "disabled",
            "currentVersion": "1.0.0",
            "availableVersion": null,
            "releaseName": null,
            "releaseNotes": null,
            "releaseDate": null,
            "feedUrl": null,
            "downloadUrl": null,
            "lastCheckedAt": null,
            "downloadedAt": null,
            "message": "Tauri updater is not configured yet."
        }
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

fn read_settings_file() -> Result<Value, String> {
    let path = settings_path()?;

    if !path.exists() {
        return Ok(default_settings());
    }

    let raw_settings = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let saved_settings = serde_json::from_str::<Value>(&raw_settings)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;

    Ok(merge_defaults(default_settings(), saved_settings))
}

fn write_settings_file(settings: &Value) -> Result<(), String> {
    let path = settings_path()?;
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
        "notes": "This profile intentionally excludes B2/R2 access keys and the Convex node token.",
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

fn command_available(binary: &str, args: &[&str]) -> bool {
    Command::new(binary)
        .args(args)
        .output()
        .map(|output| {
            output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty()
        })
        .unwrap_or(false)
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

    if include_source_url {
        Ok(json!({
            "sourcePath": source_path,
            "sourceFileName": file_name(&path),
            "sourceUrl": format!("file://{source_path}"),
            "fileSizeBytes": metadata.len(),
            "modifiedAt": modified_at,
        }))
    } else {
        Ok(json!({
            "sourcePath": source_path,
            "sourceFileName": file_name(&path),
            "fileSizeBytes": metadata.len(),
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
    let output = Command::new("ffprobe")
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
        .map_err(|error| format!("Could not start ffprobe: {error}"))?;

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
) -> Result<(&'static str, &'static str, &'static str, &'static str), String> {
    match route {
        "web_streaming" => Ok(("auto", "vod", "approved", "none")),
        "clip_progressive" => Ok(("progressive", "clip", "approved", "none")),
        "review_draft" => Ok(("auto", "vod", "needs_review", "none")),
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
    let normalized_base = base_url.trim().trim_end_matches('/');

    if object_key.trim().is_empty() {
        normalized_base.to_string()
    } else {
        format!("{normalized_base}/{}", object_key.trim_matches('/'))
    }
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
    let reference_playlist_path = output_directory.join("0").join("index.m3u8");
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
        .map(|(index, variant)| {
            format!(
                "      <Representation id=\"{}\" bandwidth=\"{}\" width=\"{}\" height=\"{}\" codecs=\"{}\"/>",
                escape_xml_attribute(index),
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
                       startNumber="0"
                       initialization="$RepresentationID$/init_$RepresentationID$.mp4"
                       media="$RepresentationID$/segment_$Number%03d$.m4s">
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
    let output = Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|error| format!("Could not start ffmpeg: {error}"))?;

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

fn rclone_config(settings: &Value) -> String {
    [
        "[csnb2]".to_string(),
        "type = b2".to_string(),
        format!("account = {}", string_setting(settings, &["b2", "keyId"])),
        format!(
            "key = {}",
            string_setting(settings, &["b2", "applicationKey"])
        ),
        String::new(),
        "[csnr2]".to_string(),
        "type = s3".to_string(),
        "provider = Cloudflare".to_string(),
        format!(
            "access_key_id = {}",
            string_setting(settings, &["r2", "accessKeyId"])
        ),
        format!(
            "secret_access_key = {}",
            string_setting(settings, &["r2", "secretAccessKey"])
        ),
        format!(
            "endpoint = https://{}.r2.cloudflarestorage.com",
            string_setting(settings, &["r2", "accountId"])
        ),
        "acl = private".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn run_rclone(args: &[String]) -> Result<(), String> {
    let output = Command::new("rclone")
        .args(args)
        .output()
        .map_err(|error| format!("Could not start rclone: {error}"))?;

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
    let payload = build_convex_payload(job, status)?;
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
    let ffmpeg_available = command_available("ffmpeg", &["-version"]);
    let ffprobe_available = command_available("ffprobe", &["-version"]);
    let rclone_available = command_available("rclone", &["version"]);
    let watch_folder = string_setting(settings, &["watchFolder"]);
    let temp_output_path = string_setting(settings, &["tempOutputPath"]);
    let watcher_healthy = path_exists(watch_folder);
    let mut notes = Vec::new();

    if !ffmpeg_available {
        notes.push("FFmpeg is not available on PATH.");
    }
    if !ffprobe_available {
        notes.push("FFprobe is not available on PATH.");
    }
    if !rclone_available {
        notes.push("Rclone is not available on PATH.");
    }
    if !watch_folder.trim().is_empty() && !watcher_healthy {
        notes.push("Watch folder does not exist.");
    }
    if !temp_output_path.trim().is_empty() && !path_exists(temp_output_path) {
        notes.push("Temp output folder does not exist.");
    }
    if notes.is_empty() {
        notes.push("Tauri host health checks are available. Media workers are still being ported.");
    }

    json!({
        "ffmpegAvailable": ffmpeg_available,
        "ffprobeAvailable": ffprobe_available,
        "rcloneAvailable": rclone_available,
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

    Ok(build_state(system_snapshot(&settings), jobs, logs))
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
) -> Result<PathBuf, String> {
    fs::create_dir_all(output_directory)
        .map_err(|error| format!("Could not create {}: {error}", output_directory.display()))?;

    let playback_path = output_directory.join(PROGRESSIVE_H264_FILENAME);
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
    ];

    if has_audio {
        args.extend(["-map", "0:a:0?"].into_iter().map(String::from));
    }

    args.extend(
        [
            "-vf",
            "scale=w=1920:h=1080:force_original_aspect_ratio=decrease",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "21",
        ]
        .into_iter()
        .map(String::from),
    );

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
) -> Result<(PathBuf, PathBuf), String> {
    for (index, _) in HLS_VARIANTS.iter().enumerate() {
        let variant_directory = output_directory.join(index.to_string());
        fs::create_dir_all(&variant_directory).map_err(|error| {
            format!("Could not create {}: {error}", variant_directory.display())
        })?;
    }

    let master_playlist_path = output_directory.join("master.m3u8");
    let output_playlist_pattern = output_directory.join("%v").join("index.m3u8");
    let segment_pattern = output_directory.join("%v").join("segment_%03d.m4s");
    let keyframe_interval = get_hls_keyframe_interval(frame_rate);
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-filter_complex".to_string(),
        build_hls_scale_filter(),
    ];

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
            "-c:v",
            "libx264",
            "-preset",
            "medium",
        ]
        .into_iter()
        .map(String::from),
    );

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
            .map(|(index, _)| format!("v:{index},a:{index}"))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        HLS_VARIANTS
            .iter()
            .enumerate()
            .map(|(index, _)| format!("v:{index}"))
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

        emit_job_update(
            &app,
            &job_id,
            json!({
                "status": "encoding",
                "stage": "encoding",
                "message": format!("Encoding {delivery_type} package with software libx264."),
                "encodingProgress": 5,
                "encoder": "software",
                "deliveryType": delivery_type,
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
            format!("Encoding {delivery_type} package with software libx264."),
            Some(job_id.clone()),
        )?;

        let extract_poster_enabled = bool_setting(&settings, &["extractPosterFrame"], true);

        if delivery_type == "progressive" {
            let playback_path =
                run_progressive_transcode(&source_path, &output_directory, has_audio)?;
            let poster_path = if extract_poster_enabled {
                extract_poster(&playback_path, &output_directory, duration_seconds).ok()
            } else {
                None
            };
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
            let (master_playlist_path, dash_manifest_path) = run_hls_transcode(
                &source_path,
                &output_directory,
                has_audio,
                frame_rate,
                duration_seconds,
            )?;
            let poster_path = if extract_poster_enabled {
                extract_poster(&source_path, &output_directory, duration_seconds).ok()
            } else {
                None
            };

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
        let _ = update_job(
            &state,
            &job_id,
            json!({
                "status": "error",
                "stage": "error",
                "completedAt": now_iso(),
                "message": "Tauri ingest processing failed.",
                "errorMessage": error,
            }),
        );
        let _ = append_log(
            &state,
            "error",
            "transcode",
            "Tauri ingest processing failed.",
            Some(job_id),
        );
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

fn not_ported(feature: &str) -> Result<Value, String> {
    Err(format!("{feature} is not ported to the Tauri host yet."))
}

#[tauri::command]
async fn get_state(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    state_snapshot(&state)
}

#[tauri::command]
async fn load_settings(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    load_settings_from_state(&state)
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: Value,
) -> Result<Value, String> {
    let mut stored_settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?;
    let merged_settings = merge_defaults(default_settings(), settings);
    write_settings_file(&merged_settings)?;
    *stored_settings = merged_settings.clone();
    drop(stored_settings);

    Ok(json!({
        "settings": merged_settings,
        "state": state_snapshot(&state)?
    }))
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
    let merged_settings = apply_connection_profile(&current_settings, &profile);
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
        .set_file_name("csn-media-bridge.connection-profile.json")
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
        .unwrap_or_else(|| "CSN Media Bridge Connection Profile".to_string());
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
async fn check_for_app_updates() -> Result<Value, String> {
    Ok(default_state())
}

#[tauri::command]
async fn install_app_update() -> Result<(), String> {
    Err("Tauri updater installation is not configured yet.".to_string())
}

#[tauri::command]
async fn start_watching() -> Result<Value, String> {
    not_ported("Watch-folder ingest")
}

#[tauri::command]
async fn stop_watching(state: tauri::State<'_, AppState>) -> Result<Value, String> {
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

#[tauri::command]
async fn retry_job(_job_id: String) -> Result<Value, String> {
    not_ported("Job retry")
}

#[tauri::command]
async fn audit_job_uploads(_job_id: String) -> Result<Value, String> {
    not_ported("Upload audit")
}

#[tauri::command]
async fn resume_job_uploads(_job_id: String) -> Result<Value, String> {
    not_ported("Upload resume")
}

#[tauri::command]
async fn cleanup_job_uploads(_job_id: String) -> Result<Value, String> {
    not_ported("Upload cleanup")
}

#[tauri::command]
async fn refresh_system(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    state_snapshot(&state)
}

#[tauri::command]
async fn list_stored_videos() -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[tauri::command]
async fn update_stored_video_metadata(_request: Value) -> Result<(), String> {
    not_ported("Stored video metadata updates").map(|_| ())
}

#[tauri::command]
async fn delete_stored_video(_request: Value) -> Result<Value, String> {
    not_ported("Stored video deletion")
}

#[tauri::command]
async fn repair_stored_video_urls() -> Result<Value, String> {
    not_ported("Stored playback URL repair")
}

#[tauri::command]
async fn generate_stored_video_poster_candidates(_request: Value) -> Result<Vec<Value>, String> {
    Err("Stored video poster candidate generation is not ported to the Tauri host yet.".to_string())
}

#[tauri::command]
async fn apply_stored_video_poster(_request: Value) -> Result<String, String> {
    Err("Stored video poster application is not ported to the Tauri host yet.".to_string())
}

#[tauri::command]
async fn get_archive_preview_url(_request: Value) -> Result<Value, String> {
    not_ported("Archive preview")
}

#[tauri::command]
async fn retrieve_archived_master(_request: Value) -> Result<Value, String> {
    not_ported("Archive retrieval")
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

#[tauri::command]
async fn trim_clip(_request: Value) -> Result<Value, String> {
    not_ported("Trim export")
}

#[tauri::command]
async fn list_clips_for_video(_source_video_id: String) -> Result<Vec<Value>, String> {
    Ok(vec![])
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
async fn get_offload_task() -> Result<Value, String> {
    Ok(Value::Null)
}

#[tauri::command]
async fn run_offload_task(_request: Value) -> Result<Value, String> {
    not_ported("Offload task execution")
}

#[tauri::command]
async fn pause_offload_task() -> Result<Value, String> {
    Ok(Value::Null)
}

#[tauri::command]
async fn cancel_offload_task() -> Result<Value, String> {
    Ok(Value::Null)
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

    let response = call_convex_query(
        &settings,
        LIVE_HANDOFF_LIST_RECENT_QUERY,
        json!({ "limit": 25 }),
    )
    .await?;
    let jobs = set_handoff_jobs(&state, normalize_handoff_jobs(response))?;
    emit_handoff_update(&app);
    Ok(jobs)
}

#[tauri::command]
async fn wake_live_stream_handoff_worker(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings lock is unavailable.".to_string())?
        .clone();

    if !convex_is_configured(&settings) {
        return Err("Configure the Convex deployment URL before waking live handoff.".to_string());
    }

    if !storage_is_configured(&settings) {
        return Err("Configure B2/R2 storage before claiming a live handoff job.".to_string());
    }

    let node_key = desktop_node_key()?;
    let claim_response = call_convex_mutation(
        &settings,
        LIVE_HANDOFF_CLAIM_MUTATION,
        json!({ "nodeKey": node_key.clone() }),
    )
    .await?;
    let Some(claimed_job) = claimed_handoff_job(claim_response) else {
        return Ok(json!({
            "woke": true,
            "claimedJobId": null,
            "message": "No pending live handoff jobs are ready to claim."
        }));
    };
    let claimed_job_id = handoff_id(&claimed_job)?;

    upsert_handoff_job(&state, claimed_job.clone())?;
    emit_handoff_update(&app);

    let worker_app = app.clone();
    std::thread::spawn(move || {
        process_live_handoff_job(worker_app, claimed_job, node_key);
    });

    Ok(json!({
        "woke": true,
        "claimedJobId": claimed_job_id,
        "message": "Claimed live handoff job and started local processing."
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = read_settings_file().unwrap_or_else(|_| default_settings());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            jobs: Mutex::new(Vec::new()),
            logs: Mutex::new(Vec::new()),
            live_handoff_jobs: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
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
            wake_live_stream_handoff_worker
        ])
        .run(tauri::generate_context!())
        .expect("error while running CSN Media Bridge Tauri host");
}
