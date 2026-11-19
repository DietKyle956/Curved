# Oracle Cloud host provisioning (LAS-183, LAS-184, LAS-185, LAS-186, LAS-187, LAS-188)

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
a new shell, so export the variables again after logging in to the server. The
reference deployment uses `DOMAIN=158.101.127.247.sslip.io` and
`IP=158.101.127.247`; section 6 explains why.

Before you start you need an OCI tenancy in its home region, an Ed25519 key
pair, and `ssh`, `scp`, `curl`, `dig`, and `nc` on the operator workstation. A
public hostname is required for the Let's Encrypt certificate: either a
Cloudflare-managed domain as described in section 6, or the free `sslip.io`
wildcard that the reference deployment uses.

## 1. Scope and ownership

In scope:

- One Always Free Ampere A1 instance in the tenancy's home region.
- VCN, public subnet, security list, reserved public IPv4, and the public name
  (the `sslip.io` wildcard or a DNS-only Cloudflare record).
- Host bootstrap: Docker, the `deploy` account, the 100 GB data volume at
  `/srv/curved`, the repository checkout, the mode-600 environment file, and the
  production Compose stack behind Caddy.
- A public Let's Encrypt certificate for `CURVED_DOMAIN`, obtained by Caddy over
  ACME (HTTP-01 and TLS-ALPN-01), with HSTS enabled through
  `CURVED_HSTS_MAX_AGE`.
- A repeatable verifier that proves the host, the access boundary, the public
  certificate, the HTTP redirect, HSTS, compression, and Caddy's issuance log.
- Release automation on that host: `deploy/release.sh` (build, one-shot
  migration, app and Caddy recreate, authenticated public probe that requires
  HSTS under public TLS, image tagging, release state, and rollback) plus the
  GitHub Actions deploy job that runs it over SSH after verification.
- Public GitHub webhook delivery on `/webhooks/github` through
  `deploy/webhook.sh`, subscribed to `pull_request` events.
- Backups and restore: `deploy/backup.sh` writes logical Postgres dumps and
  Caddy data and config archives into timestamped sets, `deploy/restore.sh`
  restores them, `curved-backup.timer` runs the nightly set at 03:17, and
  `deploy/release.sh` takes a pre-deploy set before every migration.

The tickets split as follows:

| Ticket | Owns |
|---|---|
| LAS-183 | The instance, the network boundary, and the production stack behind Caddy. |
| LAS-184 | The data volume, Docker's data root, log rotation, and the prune timer. |
| LAS-185 | `deploy/release.sh` and the GitHub Actions deploy job. |
| LAS-186 | Public TLS, HSTS, server-sent events through the edge, and the public GitHub webhook. |
| LAS-187 | Backups of Postgres and the Caddy volumes, restore, and the backup timer. |
| LAS-188 | Free-tier keepalive (hourly low-priority CPU run) and the rebuild runbook after reclamation. |

There is no Terraform and no OCI Resource Manager stack. The OCI console steps in
this document plus the committed `deploy/bootstrap-host.sh`,
`deploy/verify-host.sh`, `deploy/release.sh`, `deploy/backup.sh`,
`deploy/restore.sh`, `deploy/webhook.sh`, `deploy/keepalive.sh`,
`deploy/docker-compose.yml`, and `deploy/Caddyfile` are the source of truth.

## 2. Topology and cost

```text
Internet
  |
  v
Public DNS-only name  <domain> -> <reserved IPv4>
  |
  v
VCN curved-vcn 10.0.0.0/16
  public subnet 10.0.0.0/24
    |
    v
  VM.Standard.A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04 aarch64
    22/tcp    sshd, key-only, ubuntu and deploy accounts
    80/tcp    Caddy (ACME HTTP-01 and the HTTPS redirect)
    443/tcp   Caddy (public HTTPS, TLS-ALPN-01)
    443/udp   Caddy (HTTP/3)
      |
      +-- app:4747 (Compose network only, no host port)
      +-- db:5432  (Compose network plus 127.0.0.1:55432 on the host)
```

Caddy terminates TLS with a Let's Encrypt certificate for the public name and
redirects every HTTP request on port 80 to HTTPS with a `308`. When
`CURVED_HSTS_MAX_AGE` is set, every HTTPS response carries
`Strict-Transport-Security: max-age=<value>`; the reference host uses
`31536000`. Server-sent events on `/api/events` are proxied unbuffered and
excluded from compression, so `issues_changed` frames reach the browser as soon
as a write lands. A localhost deployment leaves `ACME_EMAIL` empty, which keeps
Caddy's internal CA and sends no HSTS header.

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
| Unchecked | CIDR | `0.0.0.0/0` | TCP | All | `80` | ACME HTTP-01 and the HTTPS redirect |
| Unchecked | CIDR | `0.0.0.0/0` | TCP | All | `443` | HTTPS and ACME TLS-ALPN-01 |
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

## 6. Point the public name at the host

Let's Encrypt issuance needs a public name that resolves directly to the
reserved IPv4. Two arrangements are supported; both are DNS-only, meaning no
proxy sits between the internet and Caddy.

### 6.1 The `sslip.io` wildcard (reference deployment)

The reference host uses `158.101.127.247.sslip.io`. `sslip.io` runs a wildcard
DNS zone that returns the IPv4 address embedded in the name, so
`158.101.127.247.sslip.io` resolves to `158.101.127.247` without any record you
create or any account. This is why the live host needs no Cloudflare zone and
why the certificate subject is exactly that name.

Set the same values on the host:

```bash
export DOMAIN=158.101.127.247.sslip.io
export IP=158.101.127.247
```

The matching environment keys are `CURVED_DOMAIN=158.101.127.247.sslip.io` and
`ACME_EMAIL=admin@sslip.io`.

Limitations of this choice:

- The name is derived from the reserved address. Replacing the IPv4 address
  means choosing a new name, updating `CURVED_DOMAIN`, and issuing a new
  certificate.
- `sslip.io` is a shared public wildcard. It resolves names for anyone, offers
  no control over the zone, and can only be relied on while its service is
  reachable. Treat it as a convenience for this host, not as your own domain.
- Some corporate resolvers and DNS filters block wildcard services. If
  `dig +short "$DOMAIN" @1.1.1.1` returns nothing from one network, check from
  another before touching the host.

### 6.2 Your own domain through Cloudflare

1. In the Cloudflare dashboard for the domain, open **DNS** > **Records** and
   click **Add record**.
2. Set **Type** `A`, **Name** to the host label (for example `curved`, or `@`
   for the apex), **IPv4 address** to the reserved address, **Proxy status** to
   **DNS only**, and **TTL** to **Auto**.
3. Click **Save**. The cloud icon must be grey, not orange. A proxied record
   hides the origin, so Let's Encrypt cannot complete the HTTP-01 or
   TLS-ALPN-01 challenge and the direct port checks fail.

Verify propagation from the operator workstation:

```bash
dig +short "$DOMAIN" @1.1.1.1
```

The answer must be the reserved IPv4 address.

### 6.3 Changing the name later

A name change is an environment edit plus a Caddy recreate. Edit `CURVED_DOMAIN`
(and `ACME_EMAIL` if the account contact changes) in
`/srv/curved/checkout/deploy/.env`, keep mode `600`, then recreate only Caddy
with the command in section 7. Caddy reads the new site address, obtains a
certificate for it on startup, and serves it from then on; no other container
restarts.

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
shell, together with the Let's Encrypt account email, and return to the
bootstrap checkout, using the same values:

```bash
cd ~/curved-provision
export DOMAIN=curved.example.com
export ACME_EMAIL=ops@example.com
```

`ACME_EMAIL` is what switches Caddy from its internal CA to public Let's
Encrypt. It must be the address that receives certificate expiry notices; the
reference host uses the `sslip.io` contact `admin@sslip.io`. With
`--acme-email` set, bootstrap requires `--domain` to be a fully qualified
hostname and rejects `localhost`, a scheme, or a path.

Run the bootstrap as root. The command below uses the OCI Linux device symlink;
if `lsblk` reported `/dev/sdb`, use the fallback that follows.

```bash
sudo bash deploy/bootstrap-host.sh \
  --key ~/.ssh/id_ed25519.pub \
  --domain "$DOMAIN" \
  --acme-email "$ACME_EMAIL" \
  --data-device /dev/oracleoci/oraclevdb
```

If `/dev/oracleoci/oraclevdb` does not exist and `lsblk` shows the 100 GB disk as
`/dev/sdb`, use the fallback:

```bash
sudo bash deploy/bootstrap-host.sh \
  --key ~/.ssh/id_ed25519.pub \
  --domain "$DOMAIN" \
  --acme-email "$ACME_EMAIL" \
  --data-device /dev/sdb
```

Omitting `--data-device` is also supported: bootstrap auto-detects the only
unmounted 90-110 GiB disk and fails when it finds none or more than one.

The script accepts `--key` more than once, so every administrator key can be
installed in one run, and it rejects a file whose lines are not OpenSSH public
keys. Other options are `--acme-email`, `--mount-dir`, `--checkout-dir`,
`--repo-url`, and `--no-stack`; the defaults are `/srv/curved`,
`/srv/curved/checkout`, `https://github.com/DietKyle956/Curved.git`, an empty
ACME email (Caddy's internal CA), domain `localhost`, and the stack enabled.

`--acme-email EMAIL` selects public TLS. When it is set, bootstrap writes
`ACME_EMAIL=<email>` and `CURVED_HSTS_MAX_AGE=31536000` into the environment
file, so Caddy requests a Let's Encrypt certificate and every HTTPS response
carries HSTS. When it is absent, bootstrap writes `ACME_EMAIL=` and
`CURVED_HSTS_MAX_AGE=` (both empty), which keeps the internal CA and sends no
HSTS header.

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
  `GITHUB_WEBHOOK_SECRET`, `CURVED_DOMAIN` set to the `--domain` value,
  `ACME_EMAIL` set to the `--acme-email` value, `CURVED_HSTS_MAX_AGE` set to
  `31536000` when an ACME email was given and left empty otherwise, and
  `COOKIE_SECURE=1`. An existing environment file is never overwritten, and one
  that still contains `change-me` placeholders is rejected.
- Builds the app image on the host and starts the production stack with
  `docker compose -f deploy/docker-compose.yml up -d --build --wait` from the
  checkout. Compose auto-loads `deploy/.env` because that is the compose file's
  directory. With `ACME_EMAIL` set, Caddy obtains a public certificate for the
  domain during this start; with it empty, Caddy uses its internal CA.

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
- Creates `/srv/curved/backups` as `deploy:deploy` mode `0700`, then installs
  and starts `curved-backup.service` and `curved-backup.timer`. The timer runs
  the service daily at 03:17 with up to 20 minutes of randomized delay and
  `Persistent=true`, and the service runs `deploy/backup.sh nightly` as `deploy`
  with `CURVED_BACKUP_DIR=/srv/curved/backups`.
- Installs `/usr/local/bin/curved-keepalive` from `deploy/keepalive.sh` as
  `root:root` mode `0755`, then installs and enables `curved-keepalive.service`
  and `curved-keepalive.timer`. The timer runs the service hourly for ten
  minutes at idle CPU and I/O priority, which keeps the instance out of
  Oracle's idle classification (section 18.1).
- Runs one initial nightly set as `deploy` after the stack is started, so a
  fresh host ends with a published set, and fails if that set cannot be
  written.
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

### Upgrading an existing host to public TLS

A host bootstrapped before LAS-186 has `CURVED_DOMAIN=localhost`, an empty
`ACME_EMAIL`, and no HSTS. Bootstrap never rewrites an existing environment
file, so switch the running host by editing it, then recreate only Caddy.

1. Log in as `deploy` and edit the environment file:

   ```bash
   ssh deploy@"$IP"
   cd /srv/curved/checkout
   ${EDITOR:-vi} deploy/.env
   ```

   Set the three keys and leave everything else untouched (use your own domain
   name in place of the `sslip.io` example if you registered one):

   ```text
   CURVED_DOMAIN=158.101.127.247.sslip.io
   ACME_EMAIL=admin@sslip.io
   CURVED_HSTS_MAX_AGE=31536000
   ```

2. Confirm the file is still mode `600` and owned by `deploy`:

   ```bash
   chmod 600 deploy/.env
   stat -c '%a %U:%G %n' deploy/.env
   ```

   Expected: `600 deploy:deploy deploy/.env`.

3. Recreate only Caddy so it reads the new site address and ACME account. The
   app and Postgres keep running:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps caddy
   ```

4. Watch the log until issuance completes:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml logs -f --tail=50 caddy
   ```

   Success shows `certificate obtained successfully` with
   `identifier 158.101.127.247.sslip.io`, `issuer
   acme-v02.api.letsencrypt.org-directory`, and account email `admin@sslip.io`.
   The challenge may be `tls-alpn-01` on 443 or `http-01` on 80. Press Ctrl-C
   once the certificate line appears, then confirm with section 9.

Setting `CURVED_HSTS_MAX_AGE` at the same time as the public certificate is
what satisfies the release probe: public TLS without HSTS fails the probe and
leaves `curved:latest` untouched. If issuance fails, see section 15.

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

### 8.1 Public deployment

With `ACME_EMAIL` set, Caddy serves the public name with a Let's Encrypt
certificate and no browser warning. On the reference host the certificate has
subject `CN=158.101.127.247.sslip.io`, issuer `CN=YE2` under
`O=Let's Encrypt`, and expires `Feb 17 2027`. Open:

```text
https://<domain>/
```

and sign in with the `CURVED_UI_TOKEN` value. The browser shows the normal padlock
with no certificate exception to accept. If Caddy has not finished issuance yet,
the connection fails or shows a warning; wait for `certificate obtained
successfully` in the Caddy log (section 7) and retry.

Confirm the same thing from the workstation with the system trust store, without
`-k`:

```bash
curl -o /dev/null -sS -w '%{http_code} %{ssl_verify_result}\n' "https://$DOMAIN/"
```

Expected: `200 0`, meaning HTTP 200 and a verified chain (`ssl_verify_result`
0). HSTS means a browser that has seen the host will refuse plain HTTP until
`CURVED_HSTS_MAX_AGE` expires; see the HSTS lockout entry in section 15.

### 8.2 Localhost deployment with the internal CA

This path is only for a localhost deployment, where `CURVED_DOMAIN=localhost`
and `ACME_EMAIL` is empty. Caddy then signs with its own CA, so the browser
warns about an unknown issuer until the root certificate is trusted. Extract it
on the server:

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

Open `https://localhost/` and sign in with the `CURVED_UI_TOKEN` value. Before
the CA is trusted, `curl -k` is the supported way to check the endpoint. On a
public deployment none of this applies: do not install the internal CA, and do
not use `-k` for checks.

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

The checks run in this order: `os`, `deploy-user`, `deploy-ssh-dir`,
`deploy-authorized-keys`, `sshd-config`, `data-mount`, `storage`,
`docker-root`, `docker-config`, `docker-mount-dependency`,
`docker-prune-timer`, `keepalive-timer`, `backup-dir`, `backup-timer`, `backup-freshness`,
`backup-integrity`, `env-file`, `checkout`, `tcp-listeners`, `udp-listeners`,
then, unless `--skip-stack` is given, `stack`, `tls-certificate`,
`http-redirect`, `hsts`, `compression`, `caddy-issuance`, and `https-api`.

`keepalive-timer` requires both keepalive unit files to exist,
`curved-keepalive.timer` to be both enabled and active, and the service's
`ExecStart` to point at an executable `/usr/local/bin/curved-keepalive`.

The four backup checks are read-only:

- `backup-dir` requires `/srv/curved/backups` to exist, owned by `deploy`, mode
  `700`.
- `backup-timer` requires both unit files to exist and
  `curved-backup.timer` to be both enabled and active.
- `backup-freshness` takes the newest real directory under
  `/srv/curved/backups/nightly`, requires a parseable `created_at` in its
  `manifest.txt` no older than 26 hours, and a non-empty `postgres.dump`.
- `backup-integrity` requires `manifest.txt` and `SHA256SUMS` in that set and a
  passing `sha256sum -c --status SHA256SUMS` inside it.

Public mode is detected from the environment file: `ACME_EMAIL` non-empty and
the domain not `localhost`. In that mode:

- `tls-certificate` requires `200` from `https://<domain>/api/projects` with
  `ssl_verify_result` 0 and a leaf issuer that is not Caddy's local authority.
- `http-redirect` requires a `301`, `302`, `307`, or `308` whose target is an
  `https://` URL.
- `hsts` requires a `Strict-Transport-Security` header with `max-age` of at
  least `31536000`.
- `compression` requires `gzip` or `zstd` content-encoding on the shell or on
  the first `/assets/` script it references.
- `caddy-issuance` requires `certificate obtained successfully` in the Caddy log
  for the domain, plus a Let's Encrypt or ACME issuer marker.

With the internal CA, the certificate checks run with `-k` and `hsts` instead
requires that no `Strict-Transport-Security` header is sent. A full run covers
27 checks, including the five edge checks above, the keepalive check, and the
four backup checks.

### 9.2 External reachability and boundary

Run these from a machine that is not the server, using the `$DOMAIN` and `$IP`
values set earlier. They use the system trust store: never add `-k` to a check
on a public deployment, because `-k` hides exactly the certificate failure the
check exists to catch.

Certificate chain and status:

```bash
curl --resolve "$DOMAIN:443:$IP" -o /dev/null -sS \
  -w '%{http_code} %{ssl_verify_result}\n' "https://$DOMAIN/"
```

Expected: `200 0`. HTTP 200 and a verified chain (0). Any nonzero
`ssl_verify_result`, or a curl exit code naming an expired or untrusted
certificate, is a failure.

The SPA shell itself:

```bash
curl --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/"
```

This returns the app shell HTML.

Plain HTTP must redirect to HTTPS:

```bash
curl --resolve "$DOMAIN:80:$IP" -o /dev/null -sS \
  -w '%{http_code} %{redirect_url}\n' "http://$DOMAIN/"
```

Expected: `308 https://$DOMAIN/`.

HSTS must be on the HTTPS response:

```bash
curl --resolve "$DOMAIN:443:$IP" -sS -D - -o /dev/null "https://$DOMAIN/" \
  | grep -i '^strict-transport-security:'
```

Expected: `strict-transport-security: max-age=31536000`, matching
`CURVED_HSTS_MAX_AGE`.

Compression must be on the JS asset. The asset name carries a build hash, so
read it from the shell rather than hard-coding it:

```bash
asset=$(curl --resolve "$DOMAIN:443:$IP" -sS "https://$DOMAIN/" \
  | grep -oE 'src="/assets/[^"]+\.js"' | head -n 1 | cut -d'"' -f2)
curl --resolve "$DOMAIN:443:$IP" -sS -H 'Accept-Encoding: gzip' -D - \
  -o /dev/null "https://$DOMAIN$asset" | grep -i '^content-encoding:'
```

Expected: `content-encoding: gzip`. On the reference build the asset was
`/assets/index-CjN4_7RW.js`.

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
| `*:80` | `docker-proxy` or `caddy` | ACME HTTP-01 and the HTTPS redirect |
| `*:443` TCP and UDP | `docker-proxy` or `caddy` | Public HTTPS, ACME TLS-ALPN-01, and HTTP/3 |
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

The keepalive timer needs no manual step after a reboot either: bootstrap
installs and enables `curved-keepalive.timer`, which lives in
`/etc/systemd/system`, so it is reinstalled by a rerun and started by
`timers.target` at boot like the prune and backup timers. Confirm it with
`systemctl list-timers curved-keepalive.timer` after the reboot.

## 10. Acceptance evidence

The four acceptance criteria for LAS-183, with the evidence that closes each one:

| AC | Criterion | Evidence |
|---|---|---|
| AC1 | A fresh A1 instance runs the production stack and answers on its reserved IP with only 22, 80, and 443 open. | OCI **Instance details** show the instance **RUNNING** with the data volume **Attached**; the bootstrap transcript ends with `bootstrap-host: ok`; `verify-host` ends with `verify-host: ok`; the external `nc` loop succeeds on 22, 80, and 443 while the closed-port loop prints `PASS: 5432 closed` and `PASS: 4747 closed`; `curl --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/"` returns the SPA shell, and `curl --resolve "$DOMAIN:443:$IP" -o /dev/null -sS -w '%{http_code} %{ssl_verify_result}\n' "https://$DOMAIN/"` returns `200 0`. |
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

The six acceptance criteria for LAS-186, with the evidence that closes each one:

| AC | Criterion | Evidence |
|---|---|---|
| AC1 | The public host serves HTTPS with a publicly trusted certificate for its domain. | On `158.101.127.247.sslip.io` the certificate is subject `CN=158.101.127.247.sslip.io`, issuer `C=US, O=Let's Encrypt, CN=YE2`, valid until `Feb 17 14:11:43 2027 GMT`; from the operator workstation `https://158.101.127.247.sslip.io/` returns `200 0` (`http_code` 200, `ssl_verify_result` 0); `verify-host` prints `PASS tls-certificate`. |
| AC2 | Port 80 redirects to HTTPS and every HTTPS response carries HSTS with the configured max-age. | `http://158.101.127.247.sslip.io/` returns `308 https://158.101.127.247.sslip.io/`; the HTTPS response carries `strict-transport-security: max-age=31536000`, matching `CURVED_HSTS_MAX_AGE`; `verify-host` prints `PASS http-redirect` and `PASS hsts`. |
| AC3 | Server-sent events work through the public edge, and a client disconnect cancels its subscription. | A session on the public URL received the `ready` frame and then `issues_changed` with `data: 1` after a comment; the transport regression test `a client disconnect through the Node transport cancels the subscription` (`test/sse.test.ts`) proves cancellation; the compose smoke check fails unless `ready` and `issues_changed` arrive within 5 s. |
| AC4 | PR opened and reopened move the issue to In Review, merged moves it to Done, all as the git actor with a pull-request body. | PR #1 (`LIVE-1 Public webhook delivery`) opened moved issue LIVE-1 to `in_review` with event `actorType git` and body `pull request #1 opened`; merge moved it to `done` with body `pull request #1 closed`. PR #2 (`LIVE-3 Reopen probe`): open -> `in_review`, close unmerged -> ignored (status stayed `in_review`), a human move back to `in_progress`, reopen -> `in_review` with actor `git` and body `pull request #2 reopened`, merge -> `done` with body `pull request #2 closed`. |
| AC5 | Duplicate, unknown, and non-PR deliveries are acknowledged without changing state. | A replayed identical signed delivery for LIVE-2 returned `200 {"ok":true,"ignored":true}` and the issue stayed `in_review`; GitHub's Re-deliver of a processed `pull_request opened` delivery created a `redelivery: true` entry with status `200` and left LIVE-2 in `in_review`; an unknown key `NOPE-999` returned `200 {"ok":true,"ignored":true}`; non-PR `issues` and `push` deliveries also returned `200 {"ok":true,"ignored":true}`. |
| AC6 | Caddy obtains and renews the certificate automatically, and the release probe requires HSTS under public TLS before promoting a release. | The Caddy log shows `certificate obtained successfully`, `identifier 158.101.127.247.sslip.io`, `issuer acme-v02.api.letsencrypt.org-directory`, account email `admin@sslip.io`, with challenge `tls-alpn-01`; `verify-host` prints `PASS caddy-issuance`; deploy run 44551897724 printed `release: public probe ok` and `release: ok c711540`, and the public probe requires HSTS with a max-age matching `CURVED_HSTS_MAX_AGE` once `ACME_EMAIL` is set. |

`verify-host` now runs 27 checks. The transcripts recorded for LAS-183, LAS-184,
and LAS-186 above were produced by the 22-check verifier that predates the
backup and keepalive checks, so a rerun on the same host reports five more
`PASS` lines: `backup-dir`, `backup-timer`, `backup-freshness`,
`backup-integrity`, and `keepalive-timer`. The edge checks are unchanged:
`tls-certificate`, `http-redirect`, `hsts`, `compression`, `caddy-issuance`, and
`https-api` (`200` with the token, `401` without it).

The four acceptance criteria for LAS-188, with the evidence that closes each
one:

| AC | Criterion | Evidence |
|---|---|---|
| AC1 | The keepalive keeps the instance out of Oracle's idle classification. | `systemctl list-timers curved-keepalive.timer` shows the hourly schedule; `journalctl -u curved-keepalive.service` shows a run completing with status `0`; a `/proc/stat` or `mpstat` sample taken during a run shows roughly 50% total CPU use on the 2-vCPU shape; section 18.3 records the sampling date and the p95 against the 7-day window. |
| AC2 | A reclaimed instance is rebuilt from a fresh VM plus the newest off-host dump. | Section 18.2 runbook: new `VM.Standard.A1.Flex` (2 OCPU, 12 GB, Ubuntu 24.04 aarch64), the existing volume attached without formatting (or a new volume plus `restore.sh postgres`), bootstrap, then `release.sh`; `verify-host` ends with `verify-host: ok` and 27 checks. |
| AC3 | The reserved public IPv4 and the deploy known-hosts are re-established. | OCI shows the reserved address reassigned to the new instance; `ssh-keyscan -t ed25519 <ip> > known_hosts` seeds the new host key, `gh secret set DEPLOY_KNOWN_HOSTS < known_hosts` updates the secret, and `ssh-keygen -R <ip>` clears the old entry; the GitHub Actions deploy job connects and prints `release: ok`. |
| AC4 | Reclamation is treated as a restore, not as a new deployment. | Section 18.2 follows section 17.7: attach the surviving volume and do not format it, or restore the newest dump before the first release; `docker compose down -v` is never run; the sign-in, SSE, and webhook checks in section 18.2 pass on the rebuilt host. |

Record the console screenshots, the two command transcripts, the section 9.4
reboot transcript, the verifier output, the GitHub delivery log, and the deploy
run log with the ticket. Do not record the environment file, the UI token, the
webhook secret, or any generated secret.

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
| 80 | TCP | `0.0.0.0/0` | HTTP | ACME HTTP-01 and the HTTPS redirect |
| 443 | TCP | `0.0.0.0/0` | HTTPS | The UI and API, and ACME TLS-ALPN-01 |
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
  backups/                   mode 0700, owned by deploy: nightly/ and pre-deploy/
                             set directories, each kind with its own latest symlink
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

`/srv/curved/backups` is created by bootstrap as `deploy:deploy` mode `0700` and
holds the sets that `deploy/backup.sh` writes (section 17). Each set is a
timestamped directory under its kind:

```text
/srv/curved/backups/
  nightly/<YYYYMMDDTHHMMSSZ>/
    manifest.txt
    SHA256SUMS
    postgres.dump
    caddy-data.tar.gz
    caddy-config.tar.gz
  nightly/latest -> <timestamp>
  pre-deploy/<YYYYMMDDTHHMMSSZ>/   same files; the Caddy archives are present
                                   only when Caddy was running
  pre-deploy/latest -> <timestamp>
  .backup.lock
```

The kind is `nightly` or `pre-deploy`, the timestamp is UTC, files are mode
`0600`, and each kind keeps the newest 7 sets unless `--keep` or `--no-prune`
says otherwise. Both kinds live on the same 100 GB data volume as the live
database and the Docker data root. They protect against logical damage, such as
a bad migration, a dropped table, or an accidental `down -v`, but they do not
survive loss of the host or of the volume, so copy a set off the host when that
class of failure matters.

**Never run
`docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v`
on the server.** The `-v` flag deletes the named Postgres and Caddy volumes,
which destroys the database, sessions, the Caddy certificate state (ACME account
key, issued certificates) and, on a localhost deployment, the internal CA. The
only recovery is a backup set taken before the command ran, restored with
`deploy/restore.sh` (section 17). Use `down` without `-v` only when
intentionally stopping the stack, and prefer `stop` and `restart`.

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

The file is deleted on exit. When `ACME_EMAIL` is set, the certificate is
publicly trusted and no `--cacert` is used.

Under public TLS the probe also requires HSTS: a `200` without
`Strict-Transport-Security` fails, and when `CURVED_HSTS_MAX_AGE` is set its
value must equal the header's `max-age`. Under the internal CA no HSTS header is
required. This is why a public deployment sets both `ACME_EMAIL` and
`CURVED_HSTS_MAX_AGE` together. The reference host has
`CURVED_DOMAIN=158.101.127.247.sslip.io`, `ACME_EMAIL=admin@sslip.io`, and
`CURVED_HSTS_MAX_AGE=31536000`, and a passing release prints
`release: public probe ok` before `release: ok <short>`; `curl -k` is never used
by the script.

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

3. Take a pre-deploy backup before anything is built, migrated, or replaced:

   ```bash
   ./deploy/backup.sh pre-deploy --tag "$image"
   ```

   The set lands under `/srv/curved/backups/pre-deploy/<timestamp>` with a
   `latest` symlink, and its manifest records the image tag. A `pre-deploy` set
   skips the Caddy archives with a warning when Caddy is not running, which is
   the case before the first release. If the backup fails, the script prints
   `release: error: the pre-deploy backup failed; no migration, container,
   image tag, or state change happened` and exits 1, so a release never
   migrates without a restorable dump.

4. Build the app image for the current commit:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml build app
   ```

5. Apply migrations once, as a one-shot container, before the app is replaced:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml run --rm --no-deps -T app \
     node src/composition/migrate.ts
   ```

   The migration runner is idempotent and uses the same image as the release.
   If it fails, the script exits nonzero immediately and prints that the previous
   app is still serving. It does not tag `curved:latest`, does not recreate
   `app` or `caddy`, and does not write the state file.

6. Recreate the app on the new image and wait for its authenticated healthcheck:

   ```bash
   CURVED_IMAGE="$image" docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps --wait --wait-timeout 600 app
   ```

7. Recreate Caddy so it re-resolves the app container:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps caddy
   ```

8. Run the public probe under the policy in section 14.2.

9. Only after a passing probe, or an allowed first-deploy or explicit skip,
   promote the image and record the release:

   ```bash
   docker tag "curved:$short" curved:latest
   ```

   The state write follows and is atomic.

10. Print `release: ok <short>`.

The previous app keeps serving during the pre-deploy backup, the build, and the
one-shot migration, so the only outage is the brief app recreate in step 6. The
backup in step 3 stops nothing: it reads the live database with `pg_dump` and
the running Caddy volumes with `tar`. A release never stops the stack, so
`docker compose down` has no place in a deploy, and `down -v` must never run on
the server: it deletes the Postgres and Caddy volumes (section 13).

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
and prints the usual migration warning. Rollback runs no migrations and takes
no backup.

**A rollback does not reverse a migration.** The script always warns that a
non-backward-compatible migration requires a database restore instead of an
image rollback. If the release being rolled back applied a migration that
dropped or renamed a column, tightened a constraint, or otherwise changed the
schema in a way the old image cannot read, the old image either fails or writes
against an incompatible schema. In that case:

1. Stop the release and do not run an image rollback. Keep the database volume
   intact: do not run `docker compose down` to reset anything, and never
   `down -v`.
2. Restore the pre-deploy set that the release wrote. `deploy/release.sh` takes
   that set under `/srv/curved/backups/pre-deploy` before it builds, migrates,
   or replaces anything, and the manifest records the image tag it was taken
   for:

   ```bash
   cd /srv/curved/checkout
   ls -l /srv/curved/backups/pre-deploy/
   cat /srv/curved/backups/pre-deploy/latest/manifest.txt
   ./deploy/restore.sh postgres /srv/curved/backups/pre-deploy/latest --yes
   ```

   The restore verifies `SHA256SUMS` before it touches anything, stops `app`,
   runs `pg_restore --clean --if-exists` into `POSTGRES_DB`, and leaves the app
   stopped. It prints the remaining step. Use `--database` only for a drill:
   that path restores under another name and leaves the running app alone.
3. Deploy the old tag with `./deploy/release.sh rollback <tag>` after the
   restore, so the image and the schema agree.

An image rollback is safe only when the migration is backward compatible. When
it is not, the pre-deploy set is the recovery path: restore it, then roll back
the image. A release that failed before the backup step leaves the database
untouched, because the script exits before the build. Rollback takes no backup,
so rolling back does not disturb the set from the failed release.

### 14.5 Manual deploy and recovery

An operator deploys exactly what CI would deploy:

```bash
ssh deploy@"$IP"
cd /srv/curved/checkout
git fetch --prune origin main
git reset --hard origin/main
./deploy/release.sh
```

Use `--require-public-probe` for a first release on a freshly provisioned public
host, so the external path is proven before the release is recorded. To roll
back manually:

```bash
cd /srv/curved/checkout
./deploy/release.sh rollback <previous-tag>
```

If a release fails at the pre-deploy backup step, nothing changed: no image was
built, nothing was migrated or recreated, and no state was written. Read the
backup error, fix it (usually the `db` container, the environment file, or a
full data volume), and run the script again. If a release fails at the migration
step, the previous app is still serving: read the error, fix it with a new
forward migration, reset to the new `main`, and run the script again. Do not
restart `app` to retry the migration and do not tear the stack down. If a later
release fails only the probe, the new image is already serving; fix the cause
(Caddy, the certificate, HSTS, DNS, or the UI token), rerun the script, or roll
back explicitly if the new image is the problem. Because `curved:latest` still
points at the previous release after a failed probe, do not recreate the app by
hand: a plain `up` without `CURVED_IMAGE` would start the old image. Inspect the
stack with:

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
2. **DNS or a proxy in front.** A custom record must be **DNS only**. An orange
   Cloudflare cloud sends traffic to Cloudflare instead of the origin, so both
   the direct port checks and ACME validation fail. The `sslip.io` name has no
   proxy at all; if it does not resolve to `$IP`, see the ACME section below.
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

   Test the origin directly from the host. This is a listener check, not a
   certificate check, so `-k` is acceptable here only to isolate Caddy from trust
   issues:

   ```bash
   curl -k --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -sS -w '%{http_code}\n' "https://$DOMAIN/"
   ```

   A response here proves the stack is serving and the problem is outside the
   host. A connection error points at Caddy or Docker.

### Caddy cannot obtain the ACME certificate

Symptom: the browser warns about an unknown issuer, `verify-host` fails
`tls-certificate` or `caddy-issuance`, and the Caddy log shows an ACME error
instead of `certificate obtained successfully`. Work through the causes in order:

1. **The name does not resolve to this host.** Check from the operator
   workstation and compare with `$IP`:

   ```bash
   dig +short "$DOMAIN" @1.1.1.1
   ```

   The answer must be the reserved IPv4. `sslip.io` names are derived from the
   address embedded in the name, so a mismatch means `CURVED_DOMAIN` holds the
   wrong name or the instance no longer owns that address. Fix the value and
   recreate Caddy (section 7).
2. **A proxy sits in front of the origin.** A proxied Cloudflare record
   terminates TLS at Cloudflare, so the ACME challenge cannot reach Caddy. Set
   the record to **DNS only** and wait for the TTL.
3. **Port 80 is blocked.** HTTP-01 validation needs port 80 reachable from the
   internet, and TLS-ALPN-01 needs 443. Confirm both ingress rules in the
   security list and test from outside the host:

   ```bash
   for p in 80 443; do nc -zv -w 5 "$IP" "$p"; done
   ```

   A host firewall rule that drops 80 shows the same symptom; see the listener
   and firewall checks above.
4. **Let's Encrypt rate limits.** Repeated failures for one hostname trip the
   failed-validation limit, and repeated issuance for the same name trips the
   duplicate-certificate limit. Caddy logs the rate-limit error and backs off
   instead of succeeding. Do not recreate Caddy in a loop; fix the underlying
   DNS, proxy, or port problem, then wait for the window and let Caddy retry.
5. **`sslip.io` is unavailable or filtered.** The wildcard is a third-party
   service. If `dig` returns nothing for the name from several networks, the
   service or a DNS filter is the problem; switch to your own domain (section
   6.2) rather than debugging the host.

After any fix, recreate only Caddy and watch the log:

```bash
cd /srv/curved/checkout
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml up -d --no-deps caddy
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml logs -f --tail=50 caddy
```

### HSTS locks the browser out of the site

Once a browser has seen `Strict-Transport-Security: max-age=31536000`, it
refuses plain HTTP for that host for a year and will not let you click through a
certificate warning. A broken certificate or a name change then looks like the
site is gone, even though Caddy is running.

Clear it in two places:

1. Turn the header off on the host. Edit `deploy/.env` and set the key to empty:

   ```bash
   cd /srv/curved/checkout
   ${EDITOR:-vi} deploy/.env
   # CURVED_HSTS_MAX_AGE=
   ```

   Keep mode 600, then recreate Caddy so the empty value stops the `@hsts`
   header from being set:

   ```bash
   chmod 600 deploy/.env
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps caddy
   ```

2. Clear the browser's stored HSTS state, because the header already sent is
   still in force there:
   - Chrome and Edge: open `chrome://net-internals/#hsts`, use **Delete domain
     security policies** for the host.
   - Firefox: **Settings** > **Privacy & Security** > **Cookies and Site Data** >
     **Manage Data**, remove the site, or use **Forget About This Site** from
     the history entry.
   - Safari: remove the site's website data under **Settings** > **Privacy**.

Re-enable HSTS by restoring `CURVED_HSTS_MAX_AGE=31536000` and recreating Caddy
once the certificate is correct again. Never set HSTS on a localhost deployment;
leave the key empty there so the internal CA cannot lock a browser out.

### GitHub webhook deliveries fail

A delivery failure shows in the repository's webhook page and in the GitHub
delivery log, and the issue status does not move. Check the four things that
matter:

1. **The URL.** It must be exactly `https://$CURVED_DOMAIN/webhooks/github`,
   content type `application/json`. Any other path returns the SPA or a 404, not
   the webhook handler.
2. **The secret.** A `401` with a signature error means the secret in GitHub is
   not the `GITHUB_WEBHOOK_SECRET` the app is reading. GitHub never returns the
   stored secret, so a mismatch is silent on the GitHub side. Reapply it with
   `deploy/webhook.sh` (section 16), which PATCHes the existing hook in place.
3. **Expected ignores.** Replays, unknown issue keys, and non-`pull_request`
   events answer `200 {"ok":true,"ignored":true}` and change nothing. That is
   success, not a failure: `ignored: true` is the documented answer for a
   delivery the app deliberately does not act on.
4. **The delivery log.** Open the repository's **Settings** > **Webhooks** >
   the hook > **Recent Deliveries**, or use `gh api` as shown in section 16.
   Look at the response code and body of the failing delivery, then at the app
   log for the reason:

   ```bash
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml logs --tail=100 app
   ```

   `not_authenticated` means the signature did not verify; `ignored: true` is
   normal for events the app does not handle.

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

### A backup fails or the verifier's backup checks fail

`backup: error: ...` names the cause, and the existing sets and `latest` are
left alone. A nightly run fails when the `caddy` container is not running,
because a nightly set always carries the Caddy volumes: start Caddy and rerun.
`another backup is already running` means the `flock` on
`/srv/curved/backups/.backup.lock` is held, so wait for the timer or manual run
to finish. A `pg_dump` failure or an empty dump means `db` is not healthy: check
`docker compose -p curved-prod --env-file deploy/.env -f
deploy/docker-compose.yml ps` and the container log. A write error means the
data volume is full (section 13): free space, then rerun.

For the verifier: `backup-freshness` fails when the newest nightly set is older
than 26 hours, which points at the timer or the service, so read
`journalctl -u curved-backup.service`. `backup-integrity` fails when a set is
missing `SHA256SUMS` or a checksum does not match, and that set is damaged: take
a new one rather than editing the checksum. `backup-timer` fails when the units
are missing or the timer is not enabled and active; rerun bootstrap, which
rewrites both units and re-enables the timer.

### The keepalive timer is not running

Check the state and enable it:

```bash
systemctl list-timers curved-keepalive.timer
systemctl is-enabled curved-keepalive.timer
systemctl is-active curved-keepalive.timer
```

A missing timer means the units are gone, so rerun bootstrap, which rewrites
`/etc/systemd/system/curved-keepalive.service`,
`/etc/systemd/system/curved-keepalive.timer`, and
`/usr/local/bin/curved-keepalive` and enables the timer. An inactive or
recently inactive timer points at the last run: read
`journalctl -u curved-keepalive.service` and confirm the script exits `0`,
`124`, or `143`. Any other status is propagated and needs a fix before the
instance is safe from reclamation.

### The instance was reclaimed

Follow section 18.2. The console steps create a new instance, attach the
existing 100 GB block volume without formatting it, and reassign the reserved
IPv4, then the host steps rerun bootstrap and `./deploy/release.sh`. Do not
format the volume: it carries the Postgres data and the backup sets. Do not run
`docker compose down -v`: it deletes the named volumes and turns a restore into
data loss. When the volume is gone, restore the newest off-host dump before the
first release.

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

## 16. GitHub webhook

The app receives GitHub deliveries at `/webhooks/github`. The handler verifies
`X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` over the raw body before it
parses anything, so the route needs no cookie and no bearer token. Only
`pull_request` deliveries change state; everything else is acknowledged and
ignored.

`deploy/webhook.sh` creates or updates the repository hook. It requires an
authenticated `gh`, `python3`, and `git`, and it must run inside the checkout so
it can find the environment file:

```bash
deploy/webhook.sh [--repo OWNER/NAME] [--url URL] [--env-file PATH] \
  [--dry-run] [--help]
```

Defaults and inputs:

- `--repo` defaults to `OWNER/NAME` derived from the `origin` remote.
- `--url` defaults to `https://$CURVED_DOMAIN/webhooks/github`. A `localhost` or
  empty `CURVED_DOMAIN` is refused; pass `--url` for a public target.
- `--env-file` defaults to `deploy/.env` and must supply
  `GITHUB_WEBHOOK_SECRET`; the secret is sent to `gh` on stdin and never appears
  in arguments or output.
- `--dry-run` prints `webhook: would create <url>` or
  `webhook: would update <id> <url>` without writing.

The hook payload it applies is fixed:

- `active: true`
- `events: ["pull_request"]`
- `config.content_type: "json"`
- `config.url: <url>`
- `config.secret: $GITHUB_WEBHOOK_SECRET`

### 16.1 Idempotent update semantics

The script lists the repository hooks (`?per_page=100`), looks for one whose
`config.url` matches the target exactly, and then:

- If none matches, it creates the hook with `POST /repos/OWNER/NAME/hooks` and
  prints `webhook: created <id> <url>`.
- If one matches, it updates that hook with
  `PATCH /repos/OWNER/NAME/hooks/<id>` and prints
  `webhook: updated <id> <url>`.

The update path exists because GitHub never returns the stored secret. Matching
on URL and always PATCHing is what reapplies the current secret on every run, so
rerunning the script after a secret change rotates the hook in place instead of
accumulating a second hook. The reference host has hook `714067501` with
`events: ["pull_request"]`, `config.content_type: json`, and URL
`https://158.101.127.247.sslip.io/webhooks/github`, created by this script.

### 16.2 Secret rotation

`GITHUB_WEBHOOK_SECRET` is generated once by bootstrap. To rotate it:

1. Generate a new value and write it into `deploy/.env` on the host, keeping
   mode `600` and owner `deploy`.
2. Recreate the app so the handler reads the new secret from its environment:

   ```bash
   cd /srv/curved/checkout
   docker compose -p curved-prod --env-file deploy/.env \
     -f deploy/docker-compose.yml up -d --no-deps app
   ```

3. Apply the same value to GitHub:

   ```bash
   bash deploy/webhook.sh
   ```

Between steps 2 and 3 deliveries fail with `401`, so run them back to back. The
script prints `webhook: updated 714067501 https://...` on success; it never
prints the secret.

### 16.3 Delivery behavior

| Delivery | Result |
|---|---|
| PR opened | Issue moves to `in_review`, event `actorType git`, body `pull request #<n> opened` |
| PR reopened | Issue moves to `in_review`, actor `git`, body `pull request #<n> reopened` |
| PR merged | Issue moves to `done`, actor `git`, body `pull request #<n> closed` |
| PR closed unmerged | Ignored; status unchanged |
| Replay of a processed delivery | `200 {"ok":true,"ignored":true}`; no state change |
| Unknown issue key | `200 {"ok":true,"ignored":true}`; no state change |
| Any non-`pull_request` event | `200 {"ok":true,"ignored":true}`; no state change |
| Bad or missing signature | `401` with a `not_authenticated` error |

Live evidence: PR #1 opened, closed (merged), and PR #2 opened, closed unmerged,
moved back to `in_progress` by a human, reopened, and merged all produced the
rows above, and GitHub's delivery log showed `ping`, `pull_request opened`, and
`pull_request closed` all answered `200`. A replayed LIVE-2 delivery and an
unknown key `NOPE-999` both answered `200 {"ok":true,"ignored":true}` with the
issue unchanged, as did `issues` and `push` deliveries. GitHub's own Re-deliver
on a processed `pull_request opened` delivery produced a `redelivery: true`
entry with status `200` and left LIVE-2 in `in_review`.

### 16.4 Verify deliveries

List the hooks and confirm the URL, event, and active flag:

```bash
gh api "repos/OWNER/NAME/hooks" \
  --jq '.[] | {id, url: .config.url, events, active}'
```

List the most recent deliveries for the hook:

```bash
gh api "repos/OWNER/NAME/hooks/714067501/deliveries?per_page=20" \
  --jq '.[] | {id, event, status_code, delivered_at}'
```

Every accepted delivery should show `status_code` `200`, including the ignored
ones. Rejected deliveries show `401`. For a failing delivery, inspect its
recorded response and redeliver the same payload:

```bash
gh api "repos/OWNER/NAME/hooks/714067501/deliveries/<delivery-id>"
gh api --method POST \
  "repos/OWNER/NAME/hooks/714067501/deliveries/<delivery-id>/attempts"
```

The same history is visible in the repository UI under **Settings** >
**Webhooks** > the hook > **Recent Deliveries**. If deliveries return `401`,
rotate the secret with section 16.2; if they return `200` with `ignored: true`
for a PR event, check that the payload's issue key matches an existing issue.

## 17. Backups and restore

`deploy/backup.sh` writes backup sets of the Postgres database and the Caddy
volumes, `deploy/restore.sh` restores them, `curved-backup.timer` runs the
nightly set, and `deploy/release.sh` takes a pre-deploy set before it migrates.
Both scripts are invoked from the checkout and neither prints a secret value.

### 17.1 What a set contains

Each run publishes one directory under its kind, `nightly` or `pre-deploy`, with
the layout recorded in section 13:

- `postgres.dump` - `pg_dump` in custom format (`-Fc -Z 9 --no-owner
  --no-privileges`), read from the live `db` container. A run fails rather than
  publish an empty dump.
- `caddy-data.tar.gz` - the Caddy `/data` volume: the ACME account key, the
  issued certificates, and, on a localhost deployment, the internal CA.
- `caddy-config.tar.gz` - the Caddy `/config` volume.
- `manifest.txt` - one `key=value` per line: `backup_format=1`, `kind`,
  `created_at` in UTC, `git_sha` (short HEAD, or `unknown` when git is
  unavailable), `hostname`, `postgres_user`, `postgres_db`,
  `caddy=<archived|skipped>`, `tag`, and `label`.
- `SHA256SUMS` - `sha256sum` output for every stored artifact, generated inside
  the set.

Files are mode `0600` in a `0700` tree under `umask 077`, and `<kind>/latest` is
a relative symlink to the newest set. A run stages into a dot directory under
the kind and renames it into place only after the dump, the archives, the
manifest, and the checksums exist, so a failure removes the staging directory
and leaves the existing sets and `latest` untouched. A `nightly` run requires
the `caddy` container to be running; a `pre-deploy` run records
`caddy=skipped` and omits both archives with a warning when Caddy is not
running, which is the case before the first release.

`<base>/.backup.lock` is a `flock` guard: a second backup that starts while one
is running fails instead of interleaving with it.

The base directory is `$CURVED_BACKUP_DIR`, default `/srv/curved/backups`.
`deploy/bootstrap-host.sh` creates it as `deploy:deploy` mode `0700` and sets
`CURVED_BACKUP_DIR` in the backup unit, so a timer run and a manual run write
to the same tree.

### 17.2 Schedule and retention

The nightly schedule is the managed pair `curved-backup.service` and
`curved-backup.timer`. The timer fires daily at 03:17 with up to 20 minutes of
randomized delay and `Persistent=true`, so a run missed during downtime happens
at the next boot. The service runs `deploy/backup.sh nightly` as `deploy` with
`HOME=/home/deploy` and `CURVED_BACKUP_DIR=/srv/curved/backups`, at idle IO
priority. Bootstrap also takes one initial set once the stack is up, so a fresh
host has a `nightly/latest` before the first timer fire.

The pre-deploy set is part of the release, not the timer: `deploy/release.sh`
takes one after Postgres is healthy and before it builds, migrates, or replaces
anything (section 14.3). A failed pre-deploy backup aborts the release before
any change to the database, the containers, the image tags, or the state file.

Each kind keeps the newest 7 sets by default. `--keep N` changes that per run,
and `--no-prune` keeps every set; pruning happens only after a successful
publish and never removes the set that was just written. Inspect the schedule
and the sets:

```bash
systemctl list-timers curved-backup.timer
journalctl -u curved-backup.service --since -3days
ls -l /srv/curved/backups/nightly /srv/curved/backups/pre-deploy
```

The backups share the 100 GB data volume with the live database and Docker
(section 13), so 7 retained sets of each kind consume the same headroom the
database and images use. If the volume fills, Docker and Postgres fail first:
keep the retention modest and copy a set off the host (section 17.7).

### 17.3 Manual backups

```bash
cd /srv/curved/checkout
./deploy/backup.sh nightly
./deploy/backup.sh pre-deploy --tag "$(git rev-parse --short HEAD)"
./deploy/backup.sh nightly --keep 14 --label "before the schema rewrite"
./deploy/backup.sh --help
```

The kind defaults to `nightly`. The other options are `--output-dir DIR`
(default `$CURVED_BACKUP_DIR` or `/srv/curved/backups`), `--keep N`, `--tag
TAG`, `--label TEXT`, `--env-file PATH` (default `deploy/.env`),
`--compose-file PATH` (default `deploy/docker-compose.yml`), `--project NAME`
(default `curved-prod`), and `--no-prune`. The environment file supplies the
Compose interpolation and must set `POSTGRES_USER` and `POSTGRES_DB`; the
scripts require docker and Compose v2. A successful run ends with
`backup: ok <final-path>`, and the exit code is 2 for a usage error, 1 for a
failure.

Take a manual set before a risky operation such as a hand-run `psql` change, a
volume edit, or a Caddy configuration rewrite:

```bash
./deploy/backup.sh pre-deploy --label "before volume inspection"
```

### 17.4 Restore Postgres

```bash
cd /srv/curved/checkout
./deploy/restore.sh postgres /srv/curved/backups/pre-deploy/latest --yes
```

The set directory must hold `manifest.txt`, `SHA256SUMS`, and `postgres.dump`;
`latest` and any other symlink resolve through `realpath`. Both scripts verify
every artifact with `(cd "$set" && sha256sum -c --status SHA256SUMS)` before any
destructive step, so a truncated or edited dump fails before the database is
touched. Without `--yes` the script prints `restore: refusing to restore without
--yes` and exits 2.

A restore whose target is `POSTGRES_DB` is the production path: it stops `app`
first and never starts it again. The dump is replayed with `pg_restore --clean
--if-exists --no-owner --no-privileges`, which replaces the schema and data. The
script then prints `restore: ok postgres <target> in <n>s` and the remaining
step: bring the app back with `./deploy/release.sh rollback <tag>` (or `up`)
using the image that matches the backup. Verify the data before that step, for
example by querying the restored database through the `db` container.
`rollback` takes no backup and runs no migrations. `--database NAME` selects a
different target, and that path is the drill in section 17.5: the app is not
stopped and a missing target database is created.

Restoring a nightly set into production is the undo for a deletion or a bad
migration. Restoring the pre-deploy set of a failed release is the path in
section 14.4. The `pre-deploy/latest` symlink always names the most recent
pre-deploy set, so read its `manifest.txt` to confirm the `tag` and `created_at`
before you restore.

### 17.5 Restore drill

Restore into a separate database to prove a set is usable without touching the
production database. The app keeps running, and a target database that does not
exist is created first:

```bash
cd /srv/curved/checkout
./deploy/restore.sh postgres /srv/curved/backups/nightly/latest \
  --database curved_drill --yes
```

`--database` must match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. The script prints the
`dropdb` command that removes the drill database again; run it after checking
the restored rows. A drill is read-only on the production database and on the
set, so it can run on a live host.

### 17.6 Restore Caddy

```bash
cd /srv/curved/checkout
./deploy/restore.sh caddy /srv/curved/backups/nightly/latest --yes
```

The set must record `caddy=archived` and contain both archives; a pre-deploy set
taken before the first release does not qualify. The script lists both archives
with `tar -tzf` first, stops `caddy`, extracts `caddy-data.tar.gz` into `/data`
and `caddy-config.tar.gz` into `/config`, starts Caddy with `up -d --no-deps
--wait --wait-timeout 120 caddy`, and prints `restore: ok caddy`.

Use it when the Caddy volume is lost or its state is damaged: the archived
`/data` volume carries the ACME account key, the issued certificates, and the
PKI, so Caddy starts with them instead of provisioning from scratch. Postgres is
untouched by a Caddy restore, and the app keeps running.

### 17.7 Full recovery order

The backup volume is the same data volume as the database it protects, so the
sets survive a bad migration, a dropped table, or an accidental `down -v`, and
they do not survive loss of the host or the volume. Keep a copy of the newest
set outside the host for that case:

```bash
scp -r deploy@"$IP":/srv/curved/backups/nightly/latest ~/curved-backups/
```

To rebuild after host or volume loss, with an off-host set in hand:

1. Provision as in sections 3 to 7. Bootstrap recreates `/srv/curved`, the
   checkout, `deploy/.env`, `/srv/curved/backups` (mode `0700`), Docker, and the
   stack, and publishes an initial nightly set before you restore anything.
2. Copy the off-host set into the nightly tree as `deploy`, keeping its
   timestamp directory name:

   ```bash
   scp -r ~/curved-backups/<timestamp> \
     deploy@"$IP":/srv/curved/backups/nightly/
   ```

   `nightly/latest` still points at the bootstrap set, so name the copied path
   explicitly in the restore below.
3. Restore Postgres and wait for `restore: ok postgres curved in <n>s`:
   `./deploy/restore.sh postgres /srv/curved/backups/nightly/<timestamp> --yes`.
4. Restore Caddy with the same set when its manifest records
   `caddy=archived`.
5. Start the release. The old host's `curved:<tag>` images do not exist on a
   rebuilt host, so `rollback <tag>` applies only when that tag is present;
   otherwise run `./deploy/release.sh`, which builds the current checkout, takes
   a fresh pre-deploy set of the restored database, applies migrations, and
   starts the app.
6. Verify with section 9, then sign in with section 8.

### 17.8 Verification

`deploy/verify-host.sh` stays read-only and adds four backup checks to the list
in section 9.1: `backup-dir` (mode `700`, owner `deploy`), `backup-timer` (both
units present, timer enabled and active), `backup-freshness` (newest nightly set
younger than 26 hours with a non-empty `postgres.dump`), and `backup-integrity`
(`manifest.txt` and `SHA256SUMS` present, `sha256sum -c --status` passes). A
freshly bootstrapped host passes all four because bootstrap publishes an initial
nightly set.

`npm run smoke:backup` runs `bash scripts/backup-smoke.sh`, the repository-side
gate for `deploy/backup.sh` and `deploy/restore.sh`. It drives both scripts
against stub binaries in a throwaway `PATH` with no Docker daemon, database, or
real volume, and covers the set layout, the manifest keys, `SHA256SUMS`, the
`latest` symlink, the modes, retention, a failed dump leaving earlier sets
untouched, the pre-deploy Caddy skip, the `--yes` refusal, checksum tampering,
a drill restore, a production restore that leaves the app stopped, and a Caddy
restore. A manual end-to-end confirmation on the host is a drill restore
(section 17.5) plus `./deploy/backup.sh nightly` and its `backup: ok` line.

## 18. Free-tier keepalive and rebuild

### 18.1 Keepalive

Oracle reclaims Always Free compute that looks idle: an instance whose CPU
utilization stays below 20% at the 95th percentile over a seven-day window can
be stopped or reclaimed. A quiet API host reaches that easily. The keepalive
solves it by burning one core for ten minutes every hour, which lifts the 95th
percentile well above the threshold without a sustained average load.

`deploy/keepalive.sh` is installed as `/usr/local/bin/curved-keepalive`
(`root:root`, mode `0755`). It reads two environment variables:

- `CURVED_KEEPALIVE_SECONDS` is the run length, default `600` (ten minutes).
- `CURVED_KEEPALIVE_CPUS` is the CPU list, default `0`.

When `taskset` exists, the script pins the load to that CPU with
`taskset -c "$CPUS"`; otherwise it runs unpinned. The work is
`nice -n 19 ... timeout "$DURATION" bash -c 'while :; do :; done'`, so it yields
to everything else on the host. Exit status `0`, `124` (timeout expired), and
`143` (SIGTERM) all count as success; any other status is propagated and fails
the service.

`curved-keepalive.service` is a `Type=oneshot` unit with `Nice=19`,
`IOSchedulingClass=idle`, and `TimeoutStartSec=700`. `curved-keepalive.timer`
has `OnCalendar=hourly` and `AccuracySec=1min`, so the service starts within a
minute of every hour. Bootstrap installs both units, enables the timer, and
prints `PASS keepalive-timer (hourly, 10 minutes at idle priority)`.

Inspect the schedule and the last runs:

```bash
systemctl list-timers curved-keepalive.timer
journalctl -u curved-keepalive.service
```

Trigger a run without waiting for the timer and watch it:

```bash
sudo systemctl start --no-block curved-keepalive.service
journalctl -u curved-keepalive.service -f
```

Measure the load while it runs. On the 2-vCPU shape, one saturated core is about
50% of total CPU; sample `/proc/stat` with `mpstat` or `top`, or take two
`/proc/stat` samples about a minute apart while the service is active. What
matters is the band: every 7-day window should contain a stretch near 50% total
CPU from these runs while the hourly average stays low, which is exactly the
shape Oracle's idle rule looks for. The verifier records the result as
`PASS keepalive-timer: curved-keepalive.timer is enabled and active with an
hourly OnCalendar schedule and an executable keepalive script`.

### 18.2 Rebuild after reclamation

If the instance is stopped for idleness, its boot disk, the reserved IPv4, and
the block volume still exist (or the volume can be reattached). Treat the work
as a restore, not a new deployment: the data volume carries the database and the
backup sets, so it must never be formatted.

Console:

1. Create a new instance with shape `VM.Standard.A1.Flex`, 2 OCPU, 12 GB,
   image Ubuntu 24.04 aarch64, in the tenancy's home region and the availability
   domain that has capacity (section 11).
2. Attach the existing 100 GB block volume to the new instance. Do not format
   it: its ext4 filesystem already holds `/srv/curved`. If the volume was lost,
   create a fresh 100 GB volume instead and continue to the host steps; the
   data comes from the off-host dump.
3. Reassign the reserved public IPv4 (section 4) to the new instance's private
   IP, so the public name and the certificate keep working.

Host, as `ubuntu` after SSH:

1. Clone or reuse the checkout:

   ```bash
   git clone https://github.com/DietKyle956/Curved.git ~/curved-provision
   cd ~/curved-provision
   ```

2. Run bootstrap once. It preserves an existing ext4 volume without formatting,
   recreates the `deploy` user and the docker group, reinstalls the prune, backup,
   and keepalive units, reuses `deploy/.env` when it is present, and starts the
   stack:

   ```bash
   sudo bash deploy/bootstrap-host.sh --key <pub> --domain <name> --acme-email <email>
   ```

3. Reset the checkout to the release branch, then refresh the host key that the
   deploy workflow knows. The last three commands run on the operator
   workstation, because `gh` holds the repository secret:

   ```bash
   cd /srv/curved/checkout
   sudo -u deploy git fetch origin
   sudo -u deploy git reset --hard origin/main
   ssh-keyscan -t ed25519 <ip> > known_hosts
   gh secret set DEPLOY_KNOWN_HOSTS < known_hosts
   ssh-keygen -R <ip>
   ```

4. Run the release as the deploy user:

   ```bash
   sudo -u deploy ./deploy/release.sh
   ```

Data paths:

- Volume survived: the ext4 filesystem already holds the Compose named volumes,
  so Postgres data is present before the first release. Do not run
  `docker compose down -v`, and do not reformat the volume. Replace `deploy/.env`
  only if it is missing, because the database password must match the data.
- Volume lost: create a new data volume, run bootstrap to prepare it, then copy
  the newest off-host set into the nightly tree and restore before releasing:

  ```bash
  sudo bash deploy/restore.sh postgres /srv/curved/backups/nightly/latest --yes
  sudo -u deploy ./deploy/release.sh
  ```

Verify with `sudo bash deploy/verify-host.sh` (27 PASS), then sign in on the
public URL, confirm a server-sent event arrives, and send a webhook delivery
that the app acknowledges.

### 18.3 Exercise record

The keepalive is live-proven on the production host on 2026-11-19: bootstrap
installed `/usr/local/bin/curved-keepalive` and enabled
`curved-keepalive.timer` (next elapse 19:00 UTC), and a manual
`CURVED_KEEPALIVE_SECONDS=62` run sampled from `/proc/stat` every five seconds
produced 12 samples of 53-56% total CPU, p95 55%, average 54.1% on the 2-vCPU
shape. `verify-host` exited 0 with 27 PASS lines including `keepalive-timer`.
The host-side half of the rebuild is rehearsed by `npm run smoke:provision`
(fresh container bootstrap plus an idempotent reinstall) and by
`npm run smoke:backup` plus a compose restore. The console reclamation step
itself is operator-executed; fill in AC2-AC4 when it is performed.

| AC | Criterion | Evidence | Date |
|---|---|---|---|
| AC1 | The keepalive keeps the instance out of Oracle's idle classification. | 12 `/proc/stat` samples during a 62-second run: 53-56% total CPU, p95 55%, average 54.1%, against the 20% threshold; `curved-keepalive.timer` enabled and active, next elapse 19:00 UTC. | 2026-11-19 |
| AC2 | A reclaimed instance is rebuilt from a fresh VM plus the newest off-host dump. | Section 18.2 transcript, ending in `verify-host: ok`. | TBD |
| AC3 | The reserved public IPv4 and the deploy known-hosts are re-established. | OCI address reassignment plus `gh secret set DEPLOY_KNOWN_HOSTS` and a successful deploy run. | TBD |
| AC4 | Reclamation is treated as a restore. | Volume attached unformatted (or `restore.sh postgres` from the dump), never `down -v`, then sign-in, SSE, and webhook checks. | TBD |
