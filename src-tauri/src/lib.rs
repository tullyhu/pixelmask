use std::process::{Command, Stdio};
use std::time::Duration;

fn engine_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = [
        dir.join("engine"),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("engine"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

const NATIVE_BUILD: &str = "native-20260915-2";

fn engine_alive() -> bool {
    std::net::TcpStream::connect("127.0.0.1:8765").is_ok()
}

fn engine_version_ok() -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect("127.0.0.1:8765") else {
        return false;
    };
    s.set_read_timeout(Some(Duration::from_secs(2))).ok();
    if s
        .write_all(b"GET /version HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    if s.read_to_string(&mut buf).is_err() {
        return false;
    }
    buf.contains(NATIVE_BUILD)
}

fn kill_port_8765() {
    if let Ok(out) = Command::new("lsof").args(["-ti", "tcp:8765"]).output() {
        for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
            let _ = Command::new("kill").arg(pid).status();
        }
    }
}

fn spawn_engine() {
    let Some(path) = engine_path() else { return };
    let log = dirs_next_log();
    let (out, err) = match std::fs::File::create(&log) {
        Ok(f) => {
            let f2 = f.try_clone().ok();
            (Stdio::from(f), f2.map(Stdio::from).unwrap_or(Stdio::null()))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let mut cmd = Command::new(path);
    cmd.env("ENGINE_PORT", "8765").stdout(out).stderr(err);
    let _ = cmd.spawn();
}

fn dirs_next_log() -> std::path::PathBuf {
    let base = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = std::path::Path::new(&base).join("Library/Logs");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("VideoRedactor-engine.log")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if engine_path().is_some() {
        if engine_alive() && !engine_version_ok() {
            kill_port_8765();
        }
        std::thread::spawn(|| {
            let mut last_spawn = std::time::Instant::now()
                .checked_sub(Duration::from_secs(120))
                .unwrap();
            loop {
                if !engine_alive() && last_spawn.elapsed() > Duration::from_secs(45) {
                    spawn_engine();
                    last_spawn = std::time::Instant::now();
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
