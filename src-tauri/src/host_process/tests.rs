use super::*;
#[cfg(unix)]
use tauri::ipc::InvokeResponseBody;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
fn channel() -> (
    Channel<ProcessEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

#[cfg(unix)]
fn command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    command
}

/// Collects output until the exit event, which it returns last.
#[cfg(unix)]
async fn until_exit(
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
) -> (String, String, serde_json::Value) {
    let (mut stdout, mut stderr) = (String::new(), String::new());
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("process event")
            .expect("open channel");
        match event["type"].as_str() {
            Some("stdout") => stdout.push_str(event["data"].as_str().unwrap()),
            Some("stderr") => stderr.push_str(event["data"].as_str().unwrap()),
            _ => return (stdout, stderr, event),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn streams_stdin_to_stdout_until_input_closes() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), channel)
        .unwrap();
    processes
        .write("a.plugin", handle, "one\n".into(), false)
        .await
        .unwrap();
    processes
        .write("a.plugin", handle, "two\n".into(), true)
        .await
        .unwrap();
    let (stdout, _, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "one\ntwo\n");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
    assert!(processes.registry().entries.is_empty());
    assert_eq!(
        processes
            .write("a.plugin", handle, "late".into(), false)
            .await,
        Err("No such process".into())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reports_stderr_and_exit_code() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo oops >&2; exit 3"]),
            channel,
        )
        .unwrap();
    let (_, stderr, exit) = until_exit(&mut events).await;
    assert_eq!(stderr, "oops\n");
    assert_eq!(exit["code"], 3);
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_owning_plugin_can_write_or_kill() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), channel)
        .unwrap();
    assert!(processes
        .write("b.plugin", handle, "x".into(), false)
        .await
        .is_err());
    assert!(processes.kill("b.plugin", handle).is_err());
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["type"], "exit");
}

#[cfg(unix)]
#[tokio::test]
async fn kill_ends_the_process_and_its_descendants() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    // The shell ignores the polite signal; its child would outlive it.
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], serde_json::Value::Null);
    assert_dead(child).await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_all_ends_every_process() {
    let processes = HostProcesses::default();
    let (first, mut first_events) = channel();
    let (second, mut second_events) = channel();
    processes
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), first)
        .unwrap();
    processes
        .start(0, "b.plugin".into(), "cat", command("cat", &[]), second)
        .unwrap();
    processes.stop_all();
    // The page that reloaded hears no exit: each channel closes without one.
    for events in [&mut first_events, &mut second_events] {
        while let Some(event) = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the channel stays open after the process stops")
        {
            assert_ne!(event["type"], "exit");
        }
    }
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_that_stops_listening_stops_the_process() {
    let processes = HostProcesses::default();
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo hi; sleep 30"]),
            channel,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while processes.registry().entries.contains_key(&handle) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process stopped");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spawn_from_before_a_reload_is_refused() {
    let processes = HostProcesses::default();
    let page = processes.page();
    processes.stop_all();
    let (channel, _events) = channel();
    let refused = processes.start(page, "a.plugin".into(), "cat", command("cat", &[]), channel);
    assert_eq!(refused.err().as_deref(), Some("The page reloaded"));
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_process_may_close_its_output_and_carry_on() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "exec >&- 2>&-; sleep 1; exit 4"]),
            channel,
        )
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], 4);
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_kills_every_group_without_waiting() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.shutdown();
    assert_dead(child).await;
}

#[test]
fn text_waits_for_a_split_character() {
    let mut pending = "héllo".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "h");
    assert_eq!(pending, [0xc3]);
    pending.extend_from_slice(&"héllo".as_bytes()[2..]);
    assert_eq!(take_text(&mut pending), "éllo");
    assert!(pending.is_empty());
    let mut invalid = vec![b'a', 0xff, b'b'];
    assert_eq!(take_text(&mut invalid), "a\u{fffd}b");
}

#[test]
fn directories_are_absolute_or_under_home() {
    let home = home().unwrap();
    assert_eq!(expand_home("~").unwrap(), home);
    assert_eq!(expand_home("~/.buzz").unwrap(), home.join(".buzz"));
    assert!(expand_home("relative/dir").is_err());
    assert!(expand_home("~other/dir").is_err());
}

/// Waits until `pid` has died. A process its new parent has not reaped yet
/// still answers kill(0), as a zombie, so a zombie counts as dead.
#[cfg(unix)]
async fn assert_dead(pid: i32) {
    let dead = || {
        (unsafe { libc::kill(pid, 0) }) != 0
            || std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|out| out.stdout.trim_ascii_start().starts_with(b"Z"))
    };
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while !dead() && std::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dead(), "descendant survived");
}

#[test]
fn a_bundled_program_runs_from_the_app_bin_never_path() {
    // A goose-acp on PATH, which a bundled declaration must not pick.
    let path = tempfile::tempdir().unwrap();
    std::fs::write(path.path().join("goose-acp"), "").unwrap();
    let process = |bundled: bool| -> HostProcess {
        serde_json::from_value(serde_json::json!({
            "id": "goose",
            "program": "goose-acp",
            "bundled": bundled,
        }))
        .unwrap()
    };
    let path = path.path().as_os_str();
    assert_eq!(
        program_path(
            &process(true),
            || Some(PathBuf::from("/app/resources")),
            path
        )
        .unwrap(),
        PathBuf::from("/app/resources/bin/goose-acp")
    );
    assert!(program_path(&process(true), || None, path).is_err());
    // Only a bundled program asks for the resources.
    assert!(program_path(&process(false), || unreachable!(), path).is_ok());
}

#[test]
fn only_the_protected_claude_cli_gets_the_hook_guard() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/bundled/claude-code/manifest.json"
    ))
    .unwrap();
    let declared: Vec<_> = manifest["host"]["processes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|process| process["id"].as_str().unwrap())
        .collect();
    for id in declared {
        // `claude-protected-sh` is the only declared process that can run the
        // CLI under protection; the protected file reader prints raw base64.
        assert_eq!(
            runs_protected_claude("buzz.claude-code", id, true),
            id == "claude-protected-sh",
            "{id}"
        );
        assert!(!runs_protected_claude("buzz.claude-code", id, false));
        assert!(!runs_protected_claude("other.plugin", id, true));
    }
}

#[test]
fn protected_launch_refuses_path_programs_and_preserves_bundled_resolution() {
    let store = tempfile::tempdir().unwrap();
    let mut process: HostProcess =
        serde_json::from_value(serde_json::json!({"id":"shell", "program":"bash"})).unwrap();
    assert!(protected_program_path(&process, || unreachable!(), store.path()).is_err());
    process.bundled = true;
    process.program = "buzz-agent-command".into();
    assert_eq!(
        protected_program_path(
            &process,
            || Some(PathBuf::from("/app/resources")),
            store.path()
        )
        .unwrap(),
        PathBuf::from("/app/resources/bin/buzz-agent-command")
    );
}

#[test]
#[cfg(unix)]
fn artifact_program_requires_exact_executable_and_sibling_bytes() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let executable = root.join("agent");
    let sibling = root.join("runtime.js");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(&sibling, "original").unwrap();
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let process: HostProcess = serde_json::from_value(serde_json::json!({
        "id": "agent", "program": "agent", "artifact": {
            "path": executable.to_str().unwrap(),
            "sha256": hash(b"#!/bin/sh\nexit 0\n"),
            "siblings": [{"name": "runtime.js", "sha256": hash(b"original")}]
        }
    }))
    .unwrap();
    assert_eq!(
        program_path(&process, || unreachable!(), OsStr::new("")),
        Ok(executable.clone())
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(&sibling, "changed").unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
    std::fs::write(&sibling, "original").unwrap();
    std::fs::remove_file(&executable).unwrap();
    let target = root.join("actual");
    std::fs::write(&target, "#!/bin/sh\nexit 0\n").unwrap();
    symlink(&target, &executable).unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
}

#[test]
fn process_mcp_connection_has_an_explicit_wire_shape() {
    let connection = serde_json::json!({
        "url": "http://127.0.0.1:1234/mcp",
        "headers": [{ "name": "Authorization", "value": "Bearer agent" }]
    });
    let parsed: super::ProcessMcpConnection = serde_json::from_value(connection.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), connection);
    for invalid in [
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp", "headers": [], "extra": true}),
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp", "headers": [{"name": "Authorization", "value": "Bearer agent", "extra": true}]}),
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp"}),
    ] {
        assert!(serde_json::from_value::<super::ProcessMcpConnection>(invalid).is_err());
    }
}

#[tokio::test]
#[cfg(target_os = "macos")]
async fn protected_launches_keep_the_startup_agents_root_when_release_storage_appears() {
    use crate::agent_state::AgentState;
    use crate::sign_out::legacy_identifier::{agents, CURRENT, DEV, LEGACY};
    use sha2::{Digest, Sha256};
    use std::path::Path;

    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    std::fs::create_dir(base.join(LEGACY)).unwrap();
    let app_data = base.join(DEV);
    let startup_root = agents(DEV, &app_data);
    assert_eq!(startup_root, app_data.join("agents"));
    let state = AgentState::new(Ok(startup_root.join("state")));
    state.set("marker", Some("before")).unwrap();
    let identities = startup_root.join("identities.json");
    std::fs::write(&identities, "identities").unwrap();
    let declaration: HostProcess = serde_json::from_value(serde_json::json!({
        "id": "worker", "program": "worker", "artifact": {
            "path": "/usr/bin/true",
            "sha256": format!("{:x}", Sha256::digest(std::fs::read("/usr/bin/true").unwrap()))
        }
    }))
    .unwrap();
    let protection = ProcessProtection {
        read_only_paths: vec![],
        hidden_paths: vec![],
    };
    let first_root = state.agents_root().unwrap().to_path_buf();
    let first_target = protected_program_path(
        &declaration,
        || unreachable!(),
        &first_root.join("artifacts"),
    )
    .unwrap();
    let first_profile = protection.profile(&[first_root]).unwrap();
    let run = |profile: &str, script: &str, path: &Path| {
        let mut command = process_command(
            Path::new("/bin/sh"),
            None,
            Some(profile),
            &[],
            &[
                "-c".into(),
                script.into(),
                "worker".into(),
                path.to_str().unwrap().into(),
            ],
        );
        command.env_clear();
        command
    };
    // A contained worker can create this sibling; it must not redirect later launches.
    let release = base.join(CURRENT);
    let created = run(&first_profile, "/bin/mkdir \"$1\"", &release)
        .output()
        .await
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    assert_eq!(agents(DEV, &app_data), release.join("agents"));

    let second_root = state.agents_root().unwrap().to_path_buf();
    assert_eq!(second_root, startup_root);
    let staged = protected_program_path(
        &declaration,
        || unreachable!(),
        &second_root.join("artifacts"),
    )
    .unwrap();
    assert_eq!(staged, first_target);
    assert!(staged.starts_with(startup_root.join("artifacts")));
    assert!(!release.join("agents").exists());
    let second_profile = protection.profile(&[second_root]).unwrap();
    state.set("marker", Some("after")).unwrap();
    for profile in [&first_profile, &second_profile] {
        for path in [
            identities.clone(),
            startup_root.join("state/marker"),
            startup_root.join("artifacts/untrusted"),
        ] {
            let write = run(profile, "printf breached > \"$1\"", &path)
                .output()
                .await
                .unwrap();
            assert!(!write.status.success(), "write allowed: {path:?}");
        }
        // The owner can chmod its staged file; the worker's profile must forbid it.
        let chmod = run(profile, "/bin/chmod u+w \"$1\"", &staged)
            .output()
            .await
            .unwrap();
        assert!(!chmod.status.success(), "staged artifact was writable");
    }
    assert_eq!(std::fs::read_to_string(identities).unwrap(), "identities");
    assert_eq!(state.load().unwrap()["marker"], "after");
}

#[test]
#[cfg(target_os = "macos")]
fn snapshot_mcp_and_containment_keep_the_verified_target_and_argument_order() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = root.join("agent");
    let bytes = std::fs::read("/usr/bin/true").unwrap();
    std::fs::write(&source, &bytes).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o755)).unwrap();
    use sha2::{Digest, Sha256};
    let artifact = buzzodz_plugins::ProcessArtifact {
        path: source.to_str().unwrap().into(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        siblings: vec![],
    };
    let store = root.join("artifacts");
    let target = artifact::snapshot(&artifact, &store).unwrap();
    std::fs::write(source, b"replaced original").unwrap();
    let profile = ProcessProtection {
        read_only_paths: vec![],
        hidden_paths: vec![],
    }
    .profile(&[root])
    .unwrap();
    let helper = std::path::Path::new("/app/resources/bin/buzz-agent-command");
    let command = process_command(
        &target,
        Some(helper),
        Some(&profile),
        &["--stdio".into()],
        &["--session".into()],
    );
    assert_eq!(command.as_std().get_program(), "/usr/bin/sandbox-exec");
    assert_eq!(
        command.as_std().get_args().collect::<Vec<_>>(),
        [
            OsStr::new("-p"),
            OsStr::new(&profile),
            helper.as_os_str(),
            OsStr::new("--launch"),
            target.as_os_str(),
            OsStr::new("--stdio"),
            OsStr::new("--session")
        ]
    );
    assert!(std::process::Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&target)
        .status()
        .unwrap()
        .success());
}
