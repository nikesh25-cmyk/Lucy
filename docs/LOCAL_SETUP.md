# Run the world on your own computer

NemoWorld runs as one local Node.js process with an embedded SQLite database. Render, Docker, and a hosted database are optional. The **Mac launcher sets up its own verified Node.js 24 runtime automatically** when a compatible Node installation is absent. Windows/Linux require Node.js 24 or newer from <https://nodejs.org>.

## Click to start

Download and extract [the NemoWorld development ZIP](https://github.com/nikesh25-cmyk/Lucy/archive/refs/heads/feat/civic-world-foundation.zip), or use your existing checkout. The development branch is under draft review; main does not yet contain this release. Keep the whole folder together.

| Computer | Launcher |
| --- | --- |
| Mac | Open `Start World.command`. If macOS blocks an untrusted downloaded script, inspect it and use the terminal command below. |
| Windows | Open `Start World.cmd`. |
| Linux | Run `./start-world.sh` from the project folder. |

The launcher starts the world, prints its local address, and opens your default browser. Keep its terminal window open. Press Ctrl+C to stop; reopening the launcher restores your saved world. If the default port is occupied, it tries the next nine ports. Its printed address is the correct one for that run.

On Mac, the terminal equivalent is `bash scripts/start-mac.sh`. With Node already installed, you can also use:

```sh
npm run local
```

On a Mac, the first launch detects Intel or Apple Silicon, including a terminal running under Rosetta. If needed, it downloads the pinned official Node v24.19.0 archive over verified HTTPS, checks its pinned SHA-256 before extraction, retains the license, and stores the executable under ignored `.runtime/` inside this project. It changes no system installation. Later launches reuse that runtime. There are no npm dependencies to install. This launcher uses local loopback access and clears hosted origin settings only for its child process. It preserves your database setting and does not reset accounts, terminate an existing world, create test users, or invent administrator credentials. If another copy is already using this database, return to that copy or stop it normally before restarting.

## First account and saved state

Create your first operator account in the browser to become administrator. Choose your own private password. Create a resident character; it receives a garden, cottage, and passport. Invitations let other operators create accounts on this same installation.

Saved state is `data/world.sqlite` inside the project folder by default. Keep the folder and its data when updating; the source download does not contain your personal database. Do not commit or share database and backup files. Administrators can create verified backups from Operations. See [recovery instructions](../README.md#backup-and-recovery).

The local address works on the computer running the server. This setup provides a personal installation. Sharing it with other devices needs a separately configured reachable server address and transport setup; see [hosting instructions](DEPLOYMENT.md).

## AI reasoning

The world and account interface work without a model. To start an AI resident's reasoning, install a chosen local Ollama model or connect an independent external runtime and authorize its bounded credential. Model selection remains deferred. See [runtime setup](RUNTIME.md).

## Cloud tasks and personal computers

A Codex cloud task runs on its cloud machine. Commands there do not install software on the computer displaying your browser. To have Codex execute this installation on your computer, use a local task with the extracted project as its workspace and local execution access. A screenshot or an open Render browser tab does not provide that access.

## Verification

The launcher was exercised on the Linux cloud computer with an isolated database, browser opening disabled, a deliberately occupied port, and inherited hosted-origin settings. It selected a free loopback port, served all ten shared worlds, exposed first-account registration in local mode, and stopped cleanly. Both official Mac archives were downloaded and matched the pinned checksums. On 11 October 2026, native macOS launch, browser response, schema 5 migration, thirty shared spaces, and the 106-test suite were verified locally. Windows execution still needs checking on Windows.

## Enable local inference

On Apple Silicon, open **Enable Local AI.command** to download and verify the optional 2.5 GB model, then restart **Start World.command**. See [local AI setup](LOCAL_AI.md) for resources, provenance, recovery and model limits. The world remains usable during installation.
