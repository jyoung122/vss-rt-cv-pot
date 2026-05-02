# Reverse Proxy Implementation Handoff (Updated with Firewall Controls)

## Objective

Expose the application for limited external testing via a single entry point, with:

* No “free-tier” URLs
* Restricted access (network + app-level)
* Minimal changes to existing Docker Compose stack

---

## Target Architecture

```text
Internet → Firewall (IP Allowlist) → Caddy → App (Auth) → Services
```

---

## Firewall Requirements (Critical)

### Goal

Only allow inbound traffic from approved tester IPs to port 80.

---

## Task: Define Allowed Tester IPs

Create a list:

```text
ALLOWED_IPS:
- 1.2.3.4   # Tester A
- 5.6.7.8   # Tester B
```

---

## Task: Apply Firewall Rules on Instance

On the Crusoe instance, configure firewall rules:

### Allow HTTP from approved IPs only

```bash
sudo iptables -A INPUT -p tcp --dport 80 -s 1.2.3.4 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 80 -s 5.6.7.8 -j ACCEPT
```

### Deny all other inbound HTTP traffic

```bash
sudo iptables -A INPUT -p tcp --dport 80 -j DROP
```

---

## Task: Allow SSH Access (DO NOT BLOCK)

Ensure SSH remains accessible:

```bash
sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT
```

(Optional: restrict SSH to admin IPs if known)

---

## Task: Persist Firewall Rules

Depending on OS:

### Ubuntu/Debian:

```bash
sudo apt install iptables-persistent
sudo netfilter-persistent save
```

### Alternative (recommended if available): UFW

```bash
sudo ufw allow from 1.2.3.4 to any port 80
sudo ufw allow from 5.6.7.8 to any port 80
sudo ufw deny 80
sudo ufw allow 22
sudo ufw enable
```

---

## Validation Checklist (Firewall)

* [ ] Only allowed IPs can reach `http://<public-ip>`
* [ ] All other IPs are blocked (timeout or reject)
* [ ] SSH access remains functional
* [ ] No unintended ports exposed

---

## Reverse Proxy (Caddy)

### Task: Add Caddy Service

```yaml
caddy:
  image: caddy:2
  container_name: app-caddy
  ports:
    - "80:80"
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile
  depends_on:
    - frontend
    - backend
  networks:
    - <network>
  restart: unless-stopped
```

---

### Task: Configure Routing

```caddy
:80 {
  handle /api/* {
    reverse_proxy backend:8080
  }

  handle {
    reverse_proxy frontend:3000
  }
}
```

---

## Task: Remove Public Ports from Services

Remove all `ports:` entries from:

* frontend
* backend
* redis
* redis-commander

Only Caddy should expose a port.

---

## Application-Level Auth

### Task: Implement Email Allowlist

App must:

* Require login
* Restrict access to approved email list

Example:

```text
ALLOWED_TESTER_EMAILS=person1@company.com,person2@company.com
```

---

## Validation Checklist (End-to-End)

* [ ] Only approved IPs can reach the app
* [ ] App requires login
* [ ] Only approved emails can access
* [ ] API routes function correctly
* [ ] No direct service exposure

---

## Risks / Notes

* IP allowlisting depends on testers having stable IPs
* If tester IP changes → access will break
* Keep at least one admin IP whitelisted at all times
* Consider fallback (temporary wider access) if testing is blocked

---

## Rollback Plan

* Remove firewall restrictions
* Restore original port mappings
* Restart services

---

## Outcome

* Controlled external access
* No dependency on third-party URLs
* Minimal architecture changes
* Defense-in-depth (network + application)
