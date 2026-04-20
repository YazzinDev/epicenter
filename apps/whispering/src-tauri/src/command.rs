use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use lazy_static::lazy_static;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows process creation flag to prevent console window from appearing
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

lazy_static! {
    /// Global map of spawned processes that we can interact with later.
    /// This allows us to pipe input to long-running processes like FFmpeg
    /// to trigger graceful shutdowns.
    static ref PROCESSES: Mutex<HashMap<u32, Child>> = Mutex::new(HashMap::new());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Parse a command string into program and arguments.
/// Handles quoted arguments properly for direct execution without shell wrapper.
fn parse_command(command: &str) -> (String, Vec<String>) {
    // Match quoted strings or non-space sequences
    let re = regex::Regex::new(r#"(?:[^\s"]+|"[^"]*")+"#).unwrap();
    let parts: Vec<String> = re
        .find_iter(command)
        .map(|m| m.as_str().trim_matches('"').to_string())
        .collect();

    if parts.is_empty() {
        return (String::new(), Vec::new());
    }

    (parts[0].clone(), parts[1..].to_vec())
}

/// Execute a command and wait for it to complete.
///
/// Parses the command string into program and arguments, then executes directly
/// without using a shell wrapper. This approach provides:
/// - Consistent behavior across all platforms
/// - No shell injection vulnerabilities
/// - Lower process overhead
/// - PATH resolution still works via Command::new()
///
/// On Windows, also uses CREATE_NO_WINDOW flag to prevent console window flash (GitHub issue #815).
///
/// # Arguments
/// * `command` - The command to execute as a string
///
/// # Returns
/// Result containing the command output (stdout, stderr, exit code) or error message
///
/// # Examples
/// ```
/// execute_command("ffmpeg -version".to_string())
/// execute_command("ffmpeg -i input.wav output.mp3".to_string())
/// ```
#[tauri::command]
pub async fn execute_command(command: String) -> Result<CommandOutput, String> {
    let (program, args) = parse_command(&command);

    if program.is_empty() {
        return Err("Empty command".to_string());
    }

    println!(
        "[Rust] execute_command: program='{}', args={:?}",
        program, args
    );

    let mut cmd = Command::new(&program);
    cmd.args(&args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        println!("[Rust] execute_command: Windows - using CREATE_NO_WINDOW flag");
    }

    match cmd.output() {
        Ok(output) => {
            let result = CommandOutput {
                code: output.status.code(),
                signal: None, // Signal is Unix-specific, not available from std::process::Output
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            };
            println!(
                "[Rust] execute_command: completed with code={:?}",
                result.code
            );
            Ok(result)
        }
        Err(e) => {
            let error_msg = format!("Command execution failed: {}", e);
            println!("[Rust] execute_command: error - {}", error_msg);
            Err(error_msg)
        }
    }
}

/// Spawn a child process with piped stdin for interaction.
///
/// Parses the command string into program and arguments, then spawns directly
/// without using a shell wrapper. Unlike `execute_command`, this returns immediately 
/// with the process ID and stores the process handle in a global map for later interaction.
///
/// # Arguments
/// * `command` - The command to spawn as a string
///
/// # Returns
/// Result containing the process ID or error message
///
/// # Examples
/// ```
/// // Long-running process (e.g., FFmpeg recording)
/// spawn_command("ffmpeg -f avfoundation -i :0 output.wav".to_string())
/// ```
#[tauri::command]
pub async fn spawn_command(command: String) -> Result<u32, String> {
    let (program, args) = parse_command(&command);

    if program.is_empty() {
        return Err("Empty command".to_string());
    }

    println!(
        "[Rust] spawn_command: program='{}', args={:?}",
        program, args
    );

    let mut cmd = Command::new(&program);
    cmd.args(&args);
    // Pipe stdin so we can send 'q' for graceful shutdown of ffmpeg
    cmd.stdin(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        println!("[Rust] spawn_command: Windows - using CREATE_NO_WINDOW flag");
    }

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            let mut processes = PROCESSES.lock().unwrap();
            processes.insert(pid, child);
            println!("[Rust] spawn_command: spawned process with PID={} and stored in map", pid);
            Ok(pid)
        }
        Err(e) => {
            let error_msg = format!("Failed to spawn process: {}", e);
            println!("[Rust] spawn_command: error - {}", error_msg);
            Err(error_msg)
        }
    }
}

/// Gracefully stop a process by sending 'q' to its stdin and waiting for it to exit.
///
/// This is specifically designed for FFmpeg, which flushes its buffers when it
/// receives a 'q' character. If the process does not exit within 5 seconds,
/// it will be forcefully terminated.
///
/// # Arguments
/// * `pid` - The process ID of the child to stop
#[tauri::command]
pub async fn stop_command(pid: u32) -> Result<(), String> {
    println!("[Rust] stop_command: attempting to gracefully stop PID={}", pid);

    let mut child = {
        let mut processes = PROCESSES.lock().unwrap();
        processes.remove(&pid).ok_or_else(|| format!("Process {} not found in map", pid))?
    };

    // Try sending 'q' to stdin for ffmpeg
    if let Some(mut stdin) = child.stdin.take() {
        println!("[Rust] stop_command: sending 'q' to stdin for PID={}", pid);
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
        drop(stdin); // Closing stdin often triggers the process to read and exit
    }

    // Wait for the process to exit
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(5);

    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => {
                println!("[Rust] stop_command: process {} exited gracefully with status: {}", pid, status);
                return Ok(());
            },
            Ok(None) => {
                // Still running, wait a bit
                let _ = tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(e) => {
                println!("[Rust] stop_command: error waiting for process {}: {}", pid, e);
                break;
            }
        }
    }

    // Fallback: If we reach here, graceful stop timed out. Force kill it.
    println!("[Rust] stop_command: graceful stop timed out for PID={}, force killing", pid);
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}
