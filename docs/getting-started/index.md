# Getting started

Five short pages, in order. If you only read one, read
[Configuration layout](config-layout.md) — everything else in this project is downstream of
understanding that `~/.pi/agent/` is a tree of symlinks back into your clone.

<div class="grid cards" markdown>

- **1. [Prerequisites](prerequisites.md)** — what has to exist on the machine before you clone.
- **2. [Install](install.md)** — one script, idempotent, no `sudo`, no piped shells.
- **3. [First run](first-run.md)** — prove each provider answers, then prove the guard bites.
- **4. [Configuration layout](config-layout.md)** — where every file lives and which process reads it.
- **5. [Update](update.md)** — move the checkout forward without losing what you changed.

</div>

## The ten-minute version

```bash
git clone https://github.com/DresvyanskiyDenis/PiON.git ~/PiON
cd ~/PiON

# 1. Look before you leap — nothing is written.
./scripts/install.sh --dry-run

# 2. Do it.
./scripts/install.sh

# 3. The installer creates ~/.pi/secrets.env (0600) and tells you which variables
#    it still needs. Fill them in — nothing secret is ever written into the repo.
$EDITOR ~/.pi/secrets.env

# 4. Open a new shell so your rc file picks up the environment, then:
~/pi-config/bin/pi-check --all   # no secrets, no placeholders, no bare model ids
pi -p "reply OK"                 # a real turn against your default provider
```

If step 4 prints `OK`, you have a working agent. If it prints a provider error naming the provider,
the model, an error class and a cause chain — that is also the system working; read the error, it
is deliberately verbose. See [Troubleshooting](../operations/troubleshooting.md).

!!! warning "Do not use bare `pi -p` for anything unattended"
    `pi -p --mode json` exits **0** on a failed turn, and `pi -p` with an inherited open stdin and
    no TTY blocks forever. Both were measured against PI 0.84.0. Use
    [`bin/pi-run`](../operations/cli.md#pi-run) for cron, CI, `launchd` and scripts — it is the
    fail-closed wrapper built for exactly this. Details in [Known limitations](../limitations.md).
