---
kind: Added
---
- **server:** New server's setup script also runs on the Red Hat family —
  Fedora, Rocky Linux, AlmaLinux, CentOS Stream and RHEL — with `dnf`,
  firewalld's `drop` zone and `dnf-automatic` applying security updates. On
  EL 9, whose Node.js is 16, it installs Node.js 20 from the distribution's
  own module stream.
