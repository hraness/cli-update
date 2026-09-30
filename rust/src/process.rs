use crate::{Error, ErrorCode, Result};
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn reader(mut pipe: impl Read + Send + 'static, limit: usize, send: mpsc::Sender<Result<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 8192];
        let result = loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break Ok(bytes),
                Ok(size) => {
                    if bytes.len().saturating_add(size) > limit {
                        break Err(Error::new(
                            ErrorCode::Limit,
                            "Updater subprocess output exceeded its limit",
                        ));
                    }
                    bytes.extend_from_slice(&chunk[..size]);
                }
                Err(error) => break Err(Error::io("Read updater subprocess", error)),
            }
        };
        let _ = send.send(result);
    });
}

fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The child was put into a new process group before exec. Kill only that
        // owned group on a bounded-tool failure, including pipe-holding children.
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run an owned, noninteractive verifier/transport with bounded time and pipes.
/// Arguments must be set with `Command::arg(s)`, never remote shell text. This
/// helper is not for services, product commands, or user input.
pub fn run_bounded(
    command: &mut Command,
    max_stdout: usize,
    max_stderr: usize,
    timeout: Duration,
) -> Result<BoundedOutput> {
    if max_stdout > 512 * 1024 * 1024
        || max_stderr > 1024 * 1024
        || timeout.is_zero()
        || timeout > Duration::from_secs(300)
    {
        return Err(Error::new(
            ErrorCode::Configuration,
            "Subprocess bounds exceed updater limits",
        ));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| Error::io("Start updater subprocess", e))?;
    let (out_send, out_recv) = mpsc::channel();
    let (err_send, err_recv) = mpsc::channel();
    reader(
        child.stdout.take().expect("piped stdout"),
        max_stdout,
        out_send,
    );
    reader(
        child.stderr.take().expect("piped stderr"),
        max_stderr,
        err_send,
    );
    let started = Instant::now();
    let mut stdout = None;
    let mut stderr = None;
    let mut status = None;
    loop {
        if stdout.is_none() {
            match out_recv.try_recv() {
                Ok(Ok(value)) => stdout = Some(value),
                Ok(Err(error)) => {
                    stop(&mut child);
                    return Err(error);
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    stop(&mut child);
                    return Err(Error::new(ErrorCode::Io, "Updater stdout reader stopped"));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if stderr.is_none() {
            match err_recv.try_recv() {
                Ok(Ok(value)) => stderr = Some(value),
                Ok(Err(error)) => {
                    stop(&mut child);
                    return Err(error);
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    stop(&mut child);
                    return Err(Error::new(ErrorCode::Io, "Updater stderr reader stopped"));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => {
                    stop(&mut child);
                    return Err(Error::io("Wait for updater subprocess", error));
                }
            }
        }
        if let Some(status) = status {
            if stdout.is_some() && stderr.is_some() {
                return Ok(BoundedOutput {
                    status,
                    stdout: stdout.take().expect("checked stdout"),
                    stderr: stderr.take().expect("checked stderr"),
                });
            }
        }
        if started.elapsed() >= timeout {
            stop(&mut child);
            return Err(Error::new(
                ErrorCode::Network,
                "Updater subprocess timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
