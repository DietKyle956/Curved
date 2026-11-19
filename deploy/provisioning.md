# Oracle Cloud host provisioning (LAS-183, LAS-184, LAS-185)

This runbook creates the production host for Curved on Oracle Cloud Infrastructure
(OCI) and leaves it running the production Compose stack from `deploy/`. Follow it
top to bottom. Every console label is quoted as it appears in the OCI console.

The shell blocks use two variables. Set them in every shell where you paste a
command, replacing the example values with the real ones:

```bash
export DOMAIN=curved.example.com
export IP=203.0.113.10
```

Prose uses `<domain>` and `<ip>` for those same two values. A new SSH session is
a new shell, so export the variables again after logging in to the server.

Before you start you need an OCI tenancy in its home region, a Cloudflare-managed
domain, an Ed25519 key pair, and `ssh`, `scp`, `curl`, `dig`, and `nc` on the
operator workstation.

## 1. Scope and ownership

In scope:

- One Always Free Ampere A1 instance in the tenancy's home region.
- VCN, public subnet, security list, reserved public IPv4, and the DNS-only
  Cloudflare record.
- Host bootstrap: Docker, the `deploy` account, the 100 GB data volume at
  `/srv/curved`, the repository checkout, the mode-600 environment file, and the
  production Compose stack behind Caddy's internal CA.
- A repeatable verifier that proves the host and the access boundary.
- Release automation on that host: `deploy/release.sh` (build, one-shot
  migration, app and Caddy recreate, authenticated public probe, image tagging,
  release state, and rollback) plus the GitHub Actions deploy job that runs it
  over SSH after verification.

Out of scope, owned by later tickets:

| Ticket | Owns |
|---|---|
| LAS-186 | Public ACME certificates, HSTS, and public GitHub webhook delivery. |
| LAS-187 | Backups of Postgres and the Caddy volumes. |

There is no Terraform and no OCI Resource Manager stack. The OCI console steps in
this document plus the committed `deploy/bootstrap-host.sh`,
`deploy/verify-host.sh`, `deploy/docker-compose.yml`, and `deploy/Caddyfile` are
the source of truth.

## 2. Topology and cost

```text
Internet
  |
  v
Cloudflare DNS-only A record  <domain> -> <reserved IPv4>
  |
  v
VCN curved-vcn 10.0.0.0/16
  public subnet 10.0.0.0/24
    |
    v
  VM.Standard.A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04 aarch64
    22/tcp    sshd, key-only, ubuntu and deploy accounts
    80/tcp    Caddy (HTTP, future ACME)
    443/tcp   Caddy (HTTPS)
    443/udp   Caddy (HTTP/3)
      |
      +-- app:4747 (Compose network only, no host port)
      +-- db:5432  (Compose network plus 127.0.0.1:55432 on the host)
```

| Resource | Specification | Always Free accounting |
|---|---|---|
| Compute | `VM.Standard.A1.Flex`, 2 OCPU, 12 GB, home region | Ampere A1 Always Free allowance; $0 |
| Boot volume | 50 GB, default VPUs | Counts toward the 200 GB block storage allowance |
| Block volume | 100 GB, paravirtualized, `/srv/curved` | Counts toward the 200 GB block storage allowance |
| Block storage total | 50 GB + 100 GB = 150 GB | 150 of 200 GB used, 50 GB headroom |
| Public IPv4 | One reserved address on the instance VNIC | Reattached to the VNIC; no compute sizing involved |
| Monthly cost | No paid shape, load balancer, managed database, or extra block storage | $0 at this footprint |

Everything stays in the tenancy's home region. Always Free resources are not
available in other regions, and the A1 allowance is evaluated across the tenancy,
so do not create a second A1 instance with these 2 OCPU and 12 GB.

## 3. Create the VCN and lock down the security list

1. Sign in to the OCI console and confirm the region selector shows the tenancy's
   home region. Do not switch regions later.
2. Open **Networking** > **Virtual Cloud Networks** > **Start VCN Wizard**.
3. Select **VCN with Internet Connectivity** and click **Start VCN Wizard**.
4. Set **VCN Name** to `curved-vcn`, leave the compartment at its default, and
   keep the defaults:
   - **VCN CIDR Block** `10.0.0.0/16`
   - **Public Subnet CIDR Block** `10.0.0.0/24`
   - **Private Subnet CIDR Block** `10.0.1.0/24`
   - **Use DNS Hostnames in this VCN** checked
   - NAT gateway and service gateway enabled by the wizard
5. Click **Next**, review, and click **Create**. Wait for the VCN to become
   **Available**.
6. Open **Networking** > **Virtual Cloud Networks** > `curved-vcn` >
   **Security Lists** > **Default Security List for curved-vcn**.
7. Under **Ingress Rules**, remove every rule that is not in the table below,
   including the wizard's ICMP type 3 code 4 rule, then use **Add Ingress Rules**
   once per row. Leave **Stateless** unchecked so replies are automatic.

| Stateless | Source Type | Source CIDR | IP Protocol | Source Port Range | Destination Port Range | Description |
|---|---|---|---|---|---|---|
| Unchecked | CIDR | `0.0.0.0/0` | TCP | All | `22` | SSH administration |
| Unchecked | CIDR | `0.0.0.0/0` | TCP | All | `80` | HTTP and future ACME |
| Unchecked | CIDR | `0.0.0.0/0` | TCP | All | `443` | HTTPS |
| Unchecked | CIDR | `0.0.0.0/0` | UDP | All | `443` | HTTP/3 |

8. Under **Egress Rules**, keep exactly the default rule: destination
   `0.0.0.0/0` with IP protocol **All Protocols**. Outbound package installs and
   image pulls depend on it.

The final ingress list is four rules: `22/tcp`, `80/tcp`, `443/tcp`, and
`443/udp`. **Do not add ingress rules for 5432 or 4747.** Postgres is published
only on `127.0.0.1:55432` on the host, and the app has no host port at all; the
security list is the independent outer boundary. No network security group is
used, so the security list is the only OCI firewall in this design.

## 4. Reserve the public IPv4 address

1. Open **Networking** > **IP Management** > **Reserved Public IPs**.
2. Click **Reserve Public IP** (some console builds label it **Reserve a public
   IP**).
3. Set **Name** to `curved-ipv4`, choose the tenancy's default compartment, and
   leave **Reserved Public IP Address** empty so OCI allocates one.
4. Click **Reserve**. Copy the address; it is the `<ip>` used below.

A reserved address survives instance termination and reattachment, unlike an
ephemeral public IP.

## 5. Create the instance and attach the data volume

1. Open **Compute** > **Instances** > **Create Instance**.
2. Set **Name** to `curved-prod`.
3. Leave **Placement** and **Security** at their defaults. If the home region has
   multiple availability domains, note the selected one; the block volume must
   live in the same availability domain.
4. Under **Image and Shape**, click **Change image** and choose **Canonical
   Ubuntu**, version **24.04**, architecture **aarch64**. Click **Select image**.
5. Click **Change shape**, select the **Ampere** tab, choose
   **VM.Standard.A1.Flex**, set **Number of OCPUs** to `2` and **Amount of
   memory (GB)** to `12`. Click **Select shape**.
6. Under **Primary network**, choose **Select existing virtual cloud network** >
   `curved-vcn`, then **Select existing subnet** > the public subnet
   `10.0.0.0/24`.
7. Under **Assign a public IPv4 address**, select **Reserved public IP** and
   choose `curved-ipv4`. If the instance is created before the address is
   visible here, assign it afterwards on the instance's VNIC page under
   **IPv4 Addresses** > **Edit**.
8. Under **Add SSH keys**, select **Paste public keys** and paste the contents of
   `~/.ssh/id_ed25519.pub` from the operator workstation.
9. Under **Boot volume**, check **Specify a custom boot volume size** and enter
   `50` GB. Leave the VPU setting at its default.
10. Under **Add block volumes**, click **Create new block volume**:
    - **Name** `curved-data`
    - **Size (GB)** `100`
    - **Attachment type** `Paravirtualized`
    - **Access** `Read/write`
    - **Shareable** unchecked
11. Click **Create**. Wait for the instance lifecycle state to become
    **RUNNING**.
12. Copy the instance's public IP and confirm it matches the reserved address.
    Record the private IP as well, and confirm the attached block volume shows
    **Attached**.

If the block volume is added after instance creation, use **Compute** >
**Instances** > `curved-prod` > **Attached block volumes** > **Attach block
volume** > **Create new block volume**, then attach it as **Paravirtualized** in
the same availability domain.

## 6. Create the DNS-only A record

1. In the Cloudflare dashboard for the domain, open **DNS** > **Records** and
   click **Add record**.
2. Set **Type** `A`, **Name** to the host label (for example `curved`, or `@`
   for the apex), **IPv4 address** to the reserved address, **Proxy status** to
   **DNS only**, and **TTL** to **Auto**.
3. Click **Save**. The cloud icon must be grey, not orange. A proxied record
   hides the origin and breaks the internal CA plus the direct port checks.

Verify propagation from the operator workstation:

```bash
dig +short "$DOMAIN" @1.1.1.1
```

The answer must be the reserved IPv4 address.

## 7. Bootstrap the host

From the operator workstation, copy the public key to the instance so bootstrap
can install it for `deploy`. The private key stays on the workstation. If your
key uses a different name, substitute it in both commands and in the `--key`
argument below.

```bash
scp ~/.ssh/id_ed25519.pub ubuntu@"$IP":~/.ssh/id_ed25519.pub
ssh ubuntu@"$IP"
```

Install git if the image does not include it, clone the repository to the home
directory, and inspect the attached disks:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/DietKyle956/Curved.git ~/curved-provision
cd ~/curved-provision
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
```

`lsblk` must show the 50 GB boot disk and a second 100 GB disk with no
filesystem. OCI Linux images commonly expose the data volume as
`/dev/oracleoci/oraclevdb`; Canonical Ubuntu images commonly expose it as
`/dev/sdb`. Use the path that `lsblk` actually reports and never point
`--data-device` at the boot disk.

The `DOMAIN` export does not cross the SSH session. Set it again in the server
shell and return to the bootstrap checkout, using the same value:

```bash
cd ~/curved-provision
export DOMAIN=curved.example.com
```

Run the bootstrap as root. The command below uses the OCI Linux device symlink;
if `lsblk` reported `/dev/sdb`, use the fallback that follows.

```bash
sudo bash deploy/bootstrap-host.sh \
  --key ~/.ssh/id_ed25519.pub \
  --domain "$DOMAIN" \
  --data-device /dev/oracleoci/oraclevdb
```

If `/dev/oracleoci/oraclevdb` does not exist and `lsblk` shows the 100 GB disk as
`/dev/sdb`, use the fallback:

```bash
sudo bash deploy/bootstrap-host.sh \
  --key ~/.ssh/id_ed25519.pub \
  --domain "$DOMAIN" \
  --data-device /dev/sdb
```

Omitting `--data-device` is also supported: bootstrap auto-detects the only
unmounted 90-110 GiB disk and fails when it finds none or more than one.

The script accepts `--key` more than once, so every administrator key can be
installed in one run, and it rejects a file whose lines are not OpenSSH public
keys. Other options are `--mount-dir`, `--checkout-dir`,
`--repo-url`, and `--no-stack`; the defaults are `/srv/curved`,
`/srv/curved/checkout`, `https://github.com/DietKyle956/Curved.git`, domain
`localhost`, and the stack enabled.

The bootstrap performs these steps and prints `PASS <step>` for each:

- Installs the Docker engine from the Ubuntu archive (`docker.io`), then the
  Compose v2 plugin from `docker-compose-v2` when Ubuntu provides it, falling
  back to the Compose plugin in Docker's apt repository when it does not.
- Creates the `deploy` account with the supplied `authorized_keys`, adds it to
  the `docker` group (root-equivalent), and writes the sshd drop-in at
  `/etc/ssh/sshd_config.d/00-curved-access.conf` with key-only authentication,
  root login disabled, and `AllowUsers ubuntu deploy`. The drop-in sorts before
  cloud-init's `50-cloud-init.conf`, and the first value of a duplicated sshd
  option wins.
  The SSH service is reloaded.
- Prepares the 100 GB device as ext4, formatting only when the device has no
  filesystem, mounts it at `/srv/curved`, and records its UUID in `/etc/fstab`
  with `nofail` so a missing volume does not block boot.
- Clones the repository into `/srv/curved/checkout` with `deploy` as the owner.
- Generates `/srv/curved/checkout/deploy/.env` once with mode `600`, owner
  `deploy`, containing `POSTGRES_USER=curved`, a random `POSTGRES_PASSWORD`,
  `POSTGRES_DB=curved`, a random `CURVED_UI_TOKEN`, a random
  `GITHUB_WEBHOOK_SECRET`, `CURVED_DOMAIN` set to the `--domain` value, an empty
  `ACME_EMAIL`, and `COOKIE_SECURE=1`. An existing environment file is never
  overwritten, and one that still contains `change-me` placeholders is rejected.
- Builds the app image on the host and starts the production stack with
  `docker compose -f deploy/docker-compose.yml up -d --build --wait` from the
  checkout. Compose auto-loads `deploy/.env` because that is the compose file's
  directory. Caddy uses its internal CA because `ACME_EMAIL` is empty.

Bootstrap also moves Docker onto the data volume, in an order that keeps Docker
from ever starting without it:

- Mounts the data volume at `/srv/curved` before it configures or starts
  `docker.service`.
- Creates `/srv/curved/docker` as `root:root` mode `0710` and sets `data-root`
  to it in `/etc/docker/daemon.json`, together with the global `json-file` log
  driver at `max-size` `10m` and `max-file` `3`, and build-cache garbage
  collection enabled with `defaultKeepStorage` `5GB`.
- Installs the docker.service drop-in
  `/etc/systemd/system/docker.service.d/10-curved-data-root.conf` with
  `RequiresMountsFor=/srv/curved/docker` and
  `ConditionPathIsMountPoint=/srv/curved`.
- Installs and enables `curved-docker-prune.timer`, which runs
  `curved-docker-prune.service` daily at 04:37 with a 15 minute randomized
  delay: `docker builder prune -af --filter until=168h` drops build cache older
  than 7 days and `docker image prune -f --filter until=720h` drops unused
  images older than 30 days.
- Migrates an existing default root. When the configured root is still
  `/var/lib/docker`, that directory is non-empty, and `/srv/curved/docker` has
  no `image` directory, bootstrap stops Docker and copies the tree with
  `cp -a /var/lib/docker/. /srv/curved/docker/`, keeping the old directory in
  place. A rerun with unchanged inputs does not copy again.
- Recreates the Compose containers once when the daemon configuration changes,
  because Docker's logging defaults apply only to containers created after the
  change. The LAS-184 upgrade therefore gives the existing Postgres, app, and
  Caddy containers the 10 MB x 3 rotation. A rerun with unchanged inputs does
  not recreate them.

The old `/var/lib/docker` can be removed only after `verify-host` passes, to
reclaim space on the 50 GB boot volume.

The sshd drop-in allows only `ubuntu` and `deploy`, so run this on the Canonical
Ubuntu image whose default user is `ubuntu`, not on an image with a different
administrative account.

It finishes with `bootstrap-host: ok` and never prints a secret. If it exits
non-zero, stop at the first failing step and see section 15 before rerunning.

## 8. Sign in to the running stack

From the operator workstation, work as `deploy` for Compose operations:

```bash
ssh deploy@"$IP"
cd /srv/curved/checkout
```

Read the UI token from the environment file. The file is mode 600 and owned by
`deploy`, so no sudo is needed:

```bash
grep '^CURVED_UI_TOKEN=' deploy/.env
```

Because `ACME_EMAIL` is empty, Caddy signs with its internal CA. Extract that
root certificate and trust it on the workstation that opens the UI:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec caddy \
  cat /data/caddy/pki/authorities/local/root.crt > ~/curved-caddy-root.crt
```

From a second workstation terminal, with the `deploy` SSH session still open,
copy the certificate out:

```bash
scp deploy@"$IP":~/curved-caddy-root.crt .
```

Trust it for the current user or machine:

```bash
# Linux
sudo cp curved-caddy-root.crt /usr/local/share/ca-certificates/curved-caddy-root.crt
sudo update-ca-certificates

# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain curved-caddy-root.crt

# Windows, from an Administrator prompt
certutil -addstore -f Root curved-caddy-root.crt
```

Open `https://<domain>/` and sign in with the `CURVED_UI_TOKEN` value. Without
the CA installed the browser warns about an unknown issuer; that warning is
expected until LAS-186 switches to a public ACME certificate. `curl -k` is the
supported way to check the endpoint before the CA is trusted.

## 9. Verification

### 9.1 Host verifier

From the `ubuntu` account, or any account with sudo:

```bash
sudo bash /srv/curved/checkout/deploy/verify-host.sh
```

When `--domain` is omitted, the verifier reads `CURVED_DOMAIN` from
`/srv/curved/checkout/deploy/.env` and falls back to `localhost`, so the plain
command checks the domain that bootstrap configured. Pass `--domain` only to
override it:

```bash
sudo bash /srv/curved/checkout/deploy/verify-host.sh --domain "$DOMAIN"
```

It is read-only and also accepts `--checkout-dir`, `--mount-dir`, and
`--skip-stack`, with the same default paths as bootstrap. It prints
`PASS <check>` or `FAIL <check>: <reason>` for every check and exits 0 only when
all pass, ending with `verify-host: ok`. A failing run ends with
`verify-host: FAIL (<n>)` and never prints a secret value. Any other ending is a
failure; fix the reported check and rerun.

### 9.2 External reachability and boundary

Run these from a machine that is not the server, using the `$DOMAIN` and `$IP`
values set earlier.

```bash
curl -k --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/"
curl -k --resolve "$DOMAIN:443:$IP" -o /dev/null -sS -w '%{http_code}\n' "https://$DOMAIN/"
```

The first command returns the SPA shell and the second returns `200`.

```bash
for p in 22 80 443; do nc -zv -w 5 "$IP" "$p"; done
```

All three must succeed.

```bash
for p in 5432 4747; do
  if nc -z -w 5 "$IP" "$p"; then echo "FAIL: $p open"; else echo "PASS: $p closed"; fi
done
```

Both must print `PASS: ... closed`. A timeout is acceptable evidence of a closed
port; an accepted connection is a failure.

Password and root logins must fail:

```bash
ssh -o PreferredAuthentications=password -o KbdInteractiveAuthentication=no \
  -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new deploy@"$IP"
ssh -o StrictHostKeyChecking=accept-new root@"$IP"
```

Both must end in `Permission denied (publickey).` A password prompt or a shell is
a failure.

### 9.3 Host state

On the server:

```bash
df -h / /srv/curved
findmnt -no SOURCE,FSTYPE,OPTIONS /srv/curved
sudo grep -F '/srv/curved' /etc/fstab
```

`/` is the 50 GB boot volume. `/srv/curved` is a 100 GB ext4 mount (about 98 GiB
usable) from a `/dev/disk/by-uuid/...` source in `/etc/fstab`, and the fstab line
contains `nofail`.

Device names are not stable across reboots. On the live host the 100 GB data
volume enumerated as `/dev/sda` and the 50 GB boot volume as `/dev/sdb` after
the first reboot, the reverse of the first boot. The fstab UUID and the
`/srv/curved` mount are authoritative; never key on `/dev/sdX` after bootstrap,
and re-read `lsblk` before passing `--data-device` on a later run.

```bash
cd /srv/curved/checkout
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

Expected: `db` and `app` are `running (healthy)`, and `caddy` is `running`. Use
`logs` on any container that is restarting:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=100 app caddy
```

Confirm Docker runs from the data volume, with the managed configuration, mount
gate, and prune timer:

```bash
docker info --format '{{.DockerRootDir}}'
```

Expected: `/srv/curved/docker`.

```bash
cat /etc/docker/daemon.json
```

Expected: the managed document from section 7, with `data-root`
`/srv/curved/docker`, `log-driver` `json-file`, `max-size` `10m`, `max-file`
`3`, and `builder.gc.enabled` true with `defaultKeepStorage` `5GB`.

```bash
systemctl show docker.service -p RequiresMountsFor -p ConditionPathIsMountPoint
```

Expected: `RequiresMountsFor=/srv/curved/docker` and
`ConditionPathIsMountPoint=/srv/curved`.

```bash
systemctl list-timers curved-docker-prune.timer
journalctl -u curved-docker-prune.service
```

Expected: the timer line names `curved-docker-prune.timer` and
`curved-docker-prune.service`, with a next run at 04:37 plus the randomized
delay. The journal shows the last run of
`docker builder prune -af --filter until=168h` and
`docker image prune -f --filter until=720h`; it is empty until the first timer
fire.

```bash
cd /srv/curved/checkout
docker inspect --format '{{json .HostConfig.LogConfig}}' \
  "$(docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps -q db)"
```

Expected: `{"Type":"json-file","Config":{"max-file":"3","max-size":"10m"}}`.
This proves the running Postgres container was recreated after the daemon
defaults changed; containers created before LAS-184 would still show their old
logging configuration.

```bash
sudo ss -ltnup
```

Only these listeners are allowed:

| Socket | Process | Purpose |
|---|---|---|
| `0.0.0.0:22` and `[::]:22` | `sshd` | SSH |
| `*:80` | `docker-proxy` or `caddy` | HTTP |
| `*:443` TCP and UDP | `docker-proxy` or `caddy` | HTTPS and HTTP/3 |
| `*:68` UDP | `dhclient` or `systemd-networkd` | DHCPv4 client lease renewal |
| `*:546` UDP | `systemd-networkd` | DHCPv6 client lease renewal, when IPv6 is enabled |
| `127.0.0.1:55432` | `docker-proxy` | Postgres, loopback only, for an SSH tunnel |

Loopback may also show `127.0.0.53:53` from `systemd-resolved` and other
`127.*` sockets; those are not public. There must be no `*:4747` and no `*:5432`
listener. The host's Postgres is not public even though the container listens on
5432 inside the Compose network.

Confirm the SSH policy and the environment file permissions:

```bash
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers) '
sudo stat -c '%a %U:%G %n' /srv/curved/checkout/deploy/.env
sudo -u deploy git -C /srv/curved/checkout status --porcelain
```

Expected: `permitrootlogin no`, `passwordauthentication no`,
`kbdinteractiveauthentication no`, `pubkeyauthentication yes`, and
`allowusers ubuntu deploy`; mode `600` and owner `deploy deploy`; and no output
from `git status`, proving the checkout is clean and the environment file is
untracked.

### 9.4 Reboot persistence

Reboot the host and prove the stack returns without manual steps:

```bash
sudo reboot
```

Reconnect in a new SSH session and check the boot, the mount, the data root, the
stack, and the verifier:

```bash
uptime -p
findmnt /srv/curved
docker info --format '{{.DockerRootDir}}'
cd /srv/curved/checkout
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
sudo bash /srv/curved/checkout/deploy/verify-host.sh
```

Expected: `uptime -p` reports minutes, `findmnt` shows the ext4 data volume at
`/srv/curved`, `docker info` prints `/srv/curved/docker`, `db` and `app` are
`running (healthy)` with `caddy` `running`, and the verifier ends with
`verify-host: ok`.

`RequiresMountsFor=/srv/curved/docker` plus
`ConditionPathIsMountPoint=/srv/curved` is what makes a missing data volume
loud: Docker refuses to start rather than silently creating an empty
`/srv/curved` on the boot volume and running the stack against empty named
volumes.

## 10. Acceptance evidence

The four acceptance criteria for LAS-183, with the evidence that closes each one:

| AC | Criterion | Evidence |
|---|---|---|
| AC1 | A fresh A1 instance runs the production stack and answers on its reserved IP with only 22, 80, and 443 open. | OCI **Instance details** show the instance **RUNNING** with the data volume **Attached**; the bootstrap transcript ends with `bootstrap-host: ok`; `verify-host` ends with `verify-host: ok`; the external `nc` loop succeeds on 22, 80, and 443 while the closed-port loop prints `PASS: 5432 closed` and `PASS: 4747 closed`; `curl -k --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/"` returns the SPA shell, and `curl -k --resolve "$DOMAIN:443:$IP" -o /dev/null -sS -w '%{http_code}\n' "https://$DOMAIN/"` returns `200`. |
| AC2 | The deploy user authenticates by key only; password authentication is disabled; docker-group privilege is documented. | `sudo sshd -T` reports `permitrootlogin no`, `passwordauthentication no`, `kbdinteractiveauthentication no`, `pubkeyauthentication yes`, and `allowusers ubuntu deploy`; both the password and root SSH attempts above end in `Permission denied (publickey).`; `id -nG deploy` includes `docker`; section 12 documents that docker-group membership is root-equivalent. |
| AC3 | The host uses 150 GB of block storage against the 200 GB Always Free allowance. | OCI shows a 50 GB boot volume plus a 100 GB attached block volume; `verify-host` prints its `PASS storage: ...` line; `df -h / /srv/curved` shows the boot and data filesystems; section 13 records the 50 + 100 = 150 of 200 GB math. |
| AC4 | The out-of-capacity fallback is documented and does not switch to the micro shape. | Section 11 states the 24-hour rule, the Pay As You Go upgrade and same-shape retry in the home region, and explicitly forbids `VM.Standard.E2.1.Micro`. |

The four acceptance criteria for LAS-184, with the evidence that closes each
one:

| AC | Criterion | Evidence |
|---|---|---|
| AC1 | Docker's data-root is `/srv/curved/docker` on the 100 GB data volume; an existing `/var/lib/docker` is migrated without data loss. | `docker info --format '{{.DockerRootDir}}'` prints `/srv/curved/docker`; `cat /etc/docker/daemon.json` shows the managed `data-root`; the bootstrap transcript contains the migration `PASS docker-data (/srv/curved/docker)` line. |
| AC2 | docker.service cannot start when the data volume is not mounted. | The drop-in `/etc/systemd/system/docker.service.d/10-curved-data-root.conf` sets `RequiresMountsFor=/srv/curved/docker` and `ConditionPathIsMountPoint=/srv/curved`; `systemctl show docker.service -p RequiresMountsFor -p ConditionPathIsMountPoint` reports both; a reboot with the block volume detached or the mount missing shows `docker.service` not running. |
| AC3 | Global log rotation is json-file 10 MB x 3 and an enabled daily prune timer handles build cache and unused images. | `cat /etc/docker/daemon.json` shows `log-driver` `json-file` with `max-size` `10m` and `max-file` `3`; `docker inspect --format '{{json .HostConfig.LogConfig}}' "$(docker compose ... ps -q db)"` shows the recreated container on `json-file` with `max-size` `10m` and `max-file` `3`; `systemctl list-timers curved-docker-prune.timer` shows the daily 04:37 schedule; `journalctl -u curved-docker-prune.service` shows the `builder prune` and `image prune` runs. |
| AC4 | The stack returns after a reboot without manual steps. | The section 9.4 transcript: `uptime -p` reports minutes, `findmnt /srv/curved` shows the data volume, `docker info` prints `/srv/curved/docker`, `docker compose ps` shows the stack healthy, and `verify-host` ends with `verify-host: ok`. |

Record the console screenshots, the two command transcripts, the section 9.4
reboot transcript, and the verifier output with the ticket. Do not record the
environment file, the UI token, or any generated secret.

## 11. Capacity fallback

If instance creation fails with an out-of-capacity error, OCI has no A1 capacity
in the selected availability domain. Try the other availability domains in the
home region first, because capacity changes over time. If no A1 capacity has been
available for 24 hours:

1. In **Billing & Cost Management**, use **Upgrade to Pay As You Go** and complete
   the upgrade. Pay As You Go tenancies get priority for Ampere capacity.
2. Retry the same instance shape in the home region: `VM.Standard.A1.Flex`,
   2 OCPU, 12 GB, 50 GB boot, 100 GB block volume, reserved IPv4.
3. Keep the shape exactly as specified. Always Free A1 shapes remain $0 on a Pay
   As You Go tenancy as long as the footprint stays inside the Always Free
   allowance; only usage beyond it is billed. **Never switch to the 1 GB
   `VM.Standard.E2.1.Micro` shape**: it cannot build the image or run Postgres,
   Caddy, and the app together.
4. The reserved IPv4 address and the 100 GB block volume are independent
   resources and survive a failed or terminated instance. Reattach both in the
   same availability domain as the new instance.

If the failed attempt never reached the bootstrap, rerun bootstrap on the new
instance with the correct `--data-device`. If the volume already contains the
checkout and environment file from an earlier successful run, rerun bootstrap
with the same device: it detects the existing ext4 filesystem, mounts it, adds
the fstab entry on the new boot volume, preserves the existing checkout and
environment file, and starts the stack without reformatting.

## 12. Access boundary

| Port | Protocol | Source | Purpose | Why it is exposed |
|---|---|---|---|---|
| 22 | TCP | `0.0.0.0/0` | SSH | Administration and the GitHub Actions deploy job |
| 80 | TCP | `0.0.0.0/0` | HTTP | Caddy redirect and future ACME HTTP-01 |
| 443 | TCP | `0.0.0.0/0` | HTTPS | The UI and API |
| 443 | UDP | `0.0.0.0/0` | HTTP/3 | Caddy's QUIC listener |
| 5432 | TCP | none | Postgres | Container network only; host loopback is 55432 |
| 4747 | TCP | none | App | Compose network only, no host port |

SSH is open to the world because GitHub-hosted runner egress addresses are
dynamic and cannot be pinned in the security list. The compensating controls are
key-only authentication, root login disabled, and a deliberately small account
set: the image's `ubuntu` account for bootstrap and sudo checks, and `deploy` for
day-to-day Compose operations.
The `deploy` account is in the `docker` group, which is root-equivalent: Docker
can mount the host filesystem and run privileged containers. Treat the `deploy`
key as a root key, keep it off shared machines, rotate it if exposed, and never
add unrelated users to the `docker` group.

Secrets live only in `/srv/curved/checkout/deploy/.env`: mode 600, owner
`deploy`, gitignored, and excluded from the image by `.dockerignore`. They are
never committed, never baked into the image, and never printed by the scripts.
The Compose stack receives them through `--env-file` at runtime.

## 13. Storage accounting and layout

The Always Free block storage allowance is 200 GB. This host uses 150 GB: 50 GB
boot and 100 GB data. The remaining 50 GB is headroom, not usable capacity to
plan against.

```text
/srv/curved/                 100 GB ext4 (about 98 GiB usable), UUID in fstab, nofail
  checkout/                  git checkout owned by deploy, includes deploy/
  docker/                    live Docker data root (images, overlay2, volumes)
  release-state              last successful release record, written by deploy/release.sh
  backups/                   future backup target (LAS-187), not created by this ticket
```

`/srv/curved/docker` is Docker's data root: images, the `overlay2` storage
driver, the build cache, and the Postgres and Caddy named volumes all live on
the 100 GB data volume. The 50 GB boot volume holds the OS and the Docker
packages only.

The Postgres and Caddy data are named Compose volumes, now under
`/srv/curved/docker/volumes`:

- `/srv/curved/docker/volumes/curved-prod_curved-pgdata`
- `/srv/curved/docker/volumes/curved-prod_curved-caddy-data`
- `/srv/curved/docker/volumes/curved-prod_curved-caddy-config`

**Never run
`docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v`
on the server.** The `-v` flag deletes the named Postgres and Caddy volumes,
which destroys the database, sessions, and the internal CA with no recovery path
until LAS-187 exists. Use `down` without `-v` only when intentionally stopping
the stack, and prefer `stop` and `restart`.

## 14. Releases, deploys, and rollback

Every production release runs the same script, `./deploy/release.sh`, from
`/srv/curved/checkout`. The GitHub Actions deploy job is a thin SSH wrapper
around it, and an operator uses the same command manually. The script runs on
the aarch64 host, uses `set -euo pipefail`, loads the environment file with
`set -a; . "$ENV_FILE"; set +a`, and never calls `docker compose down` or
`down -v`. Do not hand-roll a release with `up --build`, `restart`, or a manual
`docker tag`.

The complete interface is:

```bash
deploy/release.sh [--skip-public-probe] [--require-public-probe] \
  [--state-file PATH] [--env-file PATH] [--compose-file PATH] [--help]
deploy/release.sh rollback <tag> [--skip-public-probe] \
  [--state-file PATH] [--env-file PATH] [--compose-file PATH]
```

Defaults are `deploy/.env`, `deploy/docker-compose.yml`, and the state file
`/srv/curved/release-state` (override with `CURVED_RELEASE_STATE` or
`--state-file`). The state file lives outside the checkout on the data volume so
a `git reset --hard` never erases it. `RELEASE_PROBE_ATTEMPTS` (default `30`)
and `RELEASE_PROBE_INTERVAL` (default `2`, seconds) are test seams for the public
probe; leave them unset in production.

Every Compose call uses one base command, which pins the project name to the one
the bootstrap created and therefore to the named volumes in section 13:

```bash
docker compose -p curved-prod --env-file deploy/.env -f deploy/docker-compose.yml
```

### 14.1 The GitHub Actions deploy job

The `deploy` job lives in `.github/workflows/verify.yml` beside `verify` and
declares `needs: verify`, so it starts only after the verification job passes
and never on a red build. Its condition is `github.ref == 'refs/heads/main'`, so
it runs on pushes to `main` and on a manual `workflow_dispatch` run of `main`;
the dispatch form takes an optional `skip_public_probe` boolean. The workflow
keeps its single `verify` concurrency group with `cancel-in-progress: false`, so
a queued release waits for an in-flight run instead of cancelling it.

The job builds nothing on the runner. It writes `DEPLOY_SSH_KEY` and
`DEPLOY_KNOWN_HOSTS` to temporary files with mode `600`, connects to
`deploy@"$DEPLOY_HOST"`, resets the checkout, and runs the release script on the
host. All building and container work happens on the arm64 host, so the runner
needs no Docker.

| Repository secret | Content |
|---|---|
| `DEPLOY_SSH_KEY` | Private half of a dedicated Ed25519 deploy key; the public half is in `/home/deploy/.ssh/authorized_keys`. Never the administrator key. |
| `DEPLOY_KNOWN_HOSTS` | One pinned known-hosts line for the reserved IPv4 address, so host key verification is strict. |
| `DEPLOY_HOST` | The bare host or IP (for example `158.101.127.247`). The SSH user is always `deploy`, so the destination is `deploy@$DEPLOY_HOST`. |

Known-hosts handling is strict: the job writes `DEPLOY_KNOWN_HOSTS` to a
temporary file and connects with `-o BatchMode=yes -o IdentitiesOnly=yes
-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<temp file>`. Never weaken
that to `StrictHostKeyChecking=no` or `accept-new` in automation. Update the
secret only from `ssh-keyscan` output whose fingerprint matches the instance
console out of band. The deploy key is root-equivalent through the docker group
(section 12): keep it dedicated to deploys, store it only as a repository
secret, and rotate it if it leaks.

The remote steps are:

```bash
cd /srv/curved/checkout
git fetch --prune origin main
git reset --hard origin/main
./deploy/release.sh
```

The reset is what makes a release the exact commit that passed verification. It
is safe for host-local state: `deploy/.env` is untracked and gitignored, and the
release state lives outside the checkout. A clean `git status --porcelain`
(section 9.3) means the reset discards nothing an operator meant to keep. The
job and the script never print the UI token, the database password, or any other
secret; the token stays in `deploy/.env`, is read by the script, and is passed
only in the probe's `Authorization` header.

### 14.2 Release state and the public probe

The state file is the script's memory of the last successful release. It records
`tag=curved:<short-sha>`, `sha=<short-sha>`, and `at=<UTC ISO-8601>`, and the
script replaces it atomically (temporary file plus rename) only after success.
Do not edit it by hand, and do not delete it to force a release through: a
missing state file is treated as a first deploy and changes the probe policy.

| Situation | Probe behavior |
|---|---|
| State file present (later deploy) | The probe must pass. A failure exits nonzero before the latest tag or the state write, so the last successful release record survives. |
| State file absent (first deploy) | The probe is skipped automatically with a loud message, because there is no previous successful release to compare against. `--require-public-probe` forces the probe instead. |
| `--skip-public-probe` | Skips the probe on any deploy with a warning. Use it only for a deliberate maintenance release. |
| Both probe flags | Refused as contradictory; the script exits nonzero without touching the stack. |

The bootstrap in section 7 starts the stack but writes no release state, so the
first release after provisioning is treated as a first deploy and skips the
probe unless `--require-public-probe` is passed.

The probe is `GET https://$CURVED_DOMAIN/api/projects` with
`Authorization: Bearer $CURVED_UI_TOKEN`, `curl --max-time 10`, and only HTTP
`200` counts as success. The script retries up to `RELEASE_PROBE_ATTEMPTS`
times, `RELEASE_PROBE_INTERVAL` seconds apart, to cover Caddy reload and
certificate issuance. When `ACME_EMAIL` is empty or unset, Caddy serves its
internal CA, so the script extracts the root certificate from the running
container into a temporary file and passes it as `--cacert`:

```bash
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml exec -T caddy \
  cat /data/caddy/pki/authorities/local/root.crt
```

The file is deleted on exit. When `ACME_EMAIL` is set (after LAS-186), the
certificate is publicly trusted and no `--cacert` is used. The live host has
`CURVED_DOMAIN=localhost` and an empty `ACME_EMAIL`, so its probe relies on the
extracted root CA; `curl -k` is not used by the script.

### 14.3 Deploy order

The script performs these steps in this order and stops at the first failure:

1. Resolve the repository root from git, require the environment file, and
   refuse contradictory probe flags. Compute the release identity:

   ```bash
   short=$(git rev-parse --short HEAD)
   image="curved:$short"
   ```

   The short SHA is seven characters; the image is local to the host and is
   never pushed to a registry.

2. Wait for Postgres to be healthy, creating it on a bare host:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --wait --wait-timeout 300 db
   ```

3. Build the app image for the current commit:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml build app
   ```

4. Apply migrations once, as a one-shot container, before the app is replaced:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml run --rm --no-deps -T app \
     node src/composition/migrate.ts
   ```

   The migration runner is idempotent and uses the same image as the release.
   If it fails, the script exits nonzero immediately and prints that the previous
   app is still serving. It does not tag `curved:latest`, does not recreate
   `app` or `caddy`, and does not write the state file.

5. Recreate the app on the new image and wait for its authenticated healthcheck:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps --wait --wait-timeout 600 app
   ```

6. Recreate Caddy so it re-resolves the app container:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps caddy
   ```

7. Run the public probe under the policy in section 14.2.

8. Only after a passing probe, or an allowed first-deploy or explicit skip,
   promote the image and record the release:

   ```bash
   docker tag "curved:$short" curved:latest
   ```

   The state write follows and is atomic.

9. Print `release: ok <short>`.

The previous app keeps serving during the build and the one-shot migration, so
the only outage is the brief app recreate in step 5. A release never stops the
stack, so `docker compose down` has no place in a deploy, and
`down -v` must never run on the server: it deletes the Postgres and Caddy
volumes (section 13).

### 14.4 Rollback

Roll back an image, not a schema:

```bash
cd /srv/curved/checkout
./deploy/release.sh rollback <tag>
```

The argument is normalized to `curved:<tag>`, and `docker image inspect` must
succeed for it, so the tag must already exist on the host from an earlier
release. Rollback runs no migrations. It starts the app from that image with
`CURVED_IMAGE=curved:<tag> ... up -d --no-deps --wait app`, then recreates
Caddy, then applies the same probe policy and state update as a normal deploy,
and prints the usual migration warning.

**A rollback does not reverse a migration.** The script always warns that a
non-backward-compatible migration requires a database restore instead of an
image rollback. If the release being rolled back applied a migration that
dropped or renamed a column, tightened a constraint, or otherwise changed the
schema in a way the old image cannot read, the old image either fails or writes
against an incompatible schema. In that case:

1. Stop the release and do not run an image rollback. Keep the database volume
   intact: do not run `docker compose down` to reset anything, and never
   `down -v`.
2. Restore Postgres from the pre-deploy dump with application writes stopped.
   LAS-187 owns the Postgres backup and restore path under `/srv/curved/backups`
   (section 13); use that path once it exists rather than inventing an ad-hoc
   `pg_dump` or `pg_restore` command.
3. Deploy the old tag with `./deploy/release.sh rollback <tag>` after the
   restore, so the image and the schema agree.

Until LAS-187 lands there is no automated pre-deploy dump, so treat every
migration as potentially destructive: an image rollback is safe only when the
migration is backward compatible, and a schema restore is the only recovery
otherwise.

### 14.5 Manual deploy and recovery

An operator deploys exactly what CI would deploy:

```bash
ssh deploy@"$IP"
cd /srv/curved/checkout
git fetch --prune origin main
git reset --hard origin/main
./deploy/release.sh
```

Use `--require-public-probe` once the internal CA is trusted and DNS points at
the host, so a first release still proves the external path. To roll back
manually:

```bash
cd /srv/curved/checkout
./deploy/release.sh rollback <previous-tag>
```

If a release fails at the migration step, the previous app is still serving:
read the error, fix it with a new forward migration, reset to the new `main`,
and run the script again. Do not restart `app` to retry the migration and do not
tear the stack down. If a later release fails only the probe, the new image is
already serving; fix the cause (Caddy, the CA, DNS, or the UI token), rerun the
script, or roll back explicitly if the new image is the problem. Because
`curved:latest` still points at the previous release after a failed probe, do
not recreate the app by hand: a plain `up` without `CURVED_IMAGE` would start
the old image. Inspect the stack with:

```bash
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml ps
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml logs --tail=100 app caddy
```

## 15. Troubleshooting

### Out of host capacity

The console reports an out-of-capacity error when creating the instance. Retry in
another availability domain in the home region, then follow section 11 if it
persists for 24 hours. Do not reduce the shape to fit a different availability
domain and do not create a second A1 instance to work around a failed attempt.

### SSH works but 80 or 443 is unreachable

Work outside in, and check the cheap causes first:

1. **Security list.** Open **Networking** > **Virtual Cloud Networks** >
   `curved-vcn` > **Security Lists** > **Default Security List for curved-vcn**
   and confirm the four ingress rules exist with source `0.0.0.0/0` and the
   correct protocol and destination port. The instance must use the public
   subnet associated with this list. Security list edits apply immediately.
2. **Cloudflare proxy.** The record must be **DNS only**. An orange cloud sends
   traffic to Cloudflare and hides the origin, so the direct checks fail.
3. **Host firewall.** Some OCI Ubuntu images persist a restrictive iptables
   ruleset. Inspect it and insert ACCEPT rules ahead of any REJECT:

   ```bash
   sudo iptables -S INPUT
   sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
   sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

   If `netfilter-persistent` is missing, install `iptables-persistent` first.
   Inspect `sudo nft list ruleset` as well on Ubuntu 24.04, where iptables is
   backed by nftables. Do not flush the ruleset: Docker manages chains in it.
4. **Listener.** Confirm Caddy is up and publishing:

   ```bash
   cd /srv/curved/checkout
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=100 caddy
   sudo ss -ltnp '( sport = :80 or sport = :443 )'
   ```

   Test the origin directly from the host:

   ```bash
   curl -k --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -sS -w '%{http_code}\n' "https://$DOMAIN/"
   ```

   A response here proves the stack is serving and the problem is outside the
   host. A connection error points at Caddy or Docker.

### The verifier reports a public listener on 111

A fresh OCI Ubuntu image can run `rpcbind`, which binds `0.0.0.0:111` TCP and
UDP. The stack does not need it, and `verify-host` correctly rejects it as an
unexpected public listener. Disable and mask both units:

```bash
sudo systemctl disable --now rpcbind.socket rpcbind.service
sudo systemctl mask rpcbind.socket rpcbind.service
sudo ss -ltnup | grep ':111' || echo "no 111"
```

The boot and host firewall fixes in this section are one-time host hygiene:
bootstrap does not rewrite iptables or disable distribution services, and the
verifier reports them so the operator can apply the fix.

### The app image fails to build or exits with an exec format error

The host is aarch64. Build on the host, not on an x64 workstation:

```bash
uname -m
cd /srv/curved/checkout
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --no-cache app
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

`uname -m` must print `aarch64`. Do not set `DOCKER_DEFAULT_PLATFORM` or pass
`--platform linux/amd64`; an amd64 image loaded onto this host runs under
emulation or fails with `exec format error`, and Node 26 type stripping aborts
under emulation. The Dockerfile's `node:26-slim` base, `postgres:18-alpine`, and
`caddy:2.10-alpine` are multi-arch, so a native build needs no other change.

### Docker does not start after a reboot

Docker is gated on the data volume, so a missing mount stops it instead of
letting it run on an empty root. Check the mount and the two conditions:

```bash
findmnt /srv/curved
systemctl show docker.service -p RequiresMountsFor -p ConditionPathIsMountPoint
```

Expected: `findmnt` prints the ext4 data volume, and the conditions report
`RequiresMountsFor=/srv/curved/docker` and
`ConditionPathIsMountPoint=/srv/curved`. If `findmnt` prints nothing, the block
volume is detached or not attached yet. Confirm it in the OCI console, then
mount it and start Docker:

```bash
sudo mount /srv/curved
sudo systemctl start docker
```

### `docker info` still shows `/var/lib/docker`

The daemon is running with the old configuration: either it was not restarted
after the drop-in and `daemon.json` were written, or `daemon.json` was replaced
by hand. Inspect the running root and the files:

```bash
docker info --format '{{.DockerRootDir}}'
cat /etc/docker/daemon.json
sudo systemctl show docker.service -p RequiresMountsFor
```

Rerun bootstrap with the same arguments. It rewrites the managed files
idempotently, restarts Docker only when they changed, and leaves the existing
data in place.

### Bootstrap used the wrong volume device

1. Stop and inspect the block devices:

   ```bash
   lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
   ```

   The 100 GB disk is the data volume. The 50 GB disk is the boot volume and
   must never be passed to `--data-device`.
2. Reattach or wait for the device if it is missing:

   ```bash
   sudo udevadm settle
   lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
   ```

   A block volume can only attach to an instance in its own availability domain,
   so confirm the instance and volume availability domains match.
3. Rerun bootstrap with the path that `lsblk` reports, using `/dev/sdb` on Ubuntu
   images or `/dev/oracleoci/oraclevdb` when that symlink exists. Do not format
   the volume by hand; if bootstrap already mounted the correct volume, rerun the
   verifier instead of bootstrap.

### Compose reports a required variable is missing

The stack was started without the environment file, or from the wrong directory.
Run it from `/srv/curved/checkout` with both flags:

```bash
cd /srv/curved/checkout
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

Errors such as `POSTGRES_PASSWORD is required` mean the environment file is
missing or was not passed. Do not create a second environment file; bootstrap
generates it once and preserves it.

### Port 80 or 443 is already in use

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Stop the conflicting service or container. The production stack owns 80 and 443;
the development stack from the repository root is not meant to run on this host.
