---
kind: Added
---
- **browser:** *Open on my phone* in phone mode. A local dev server's page
  (Vite, Next, webpack on localhost) opens on a real phone on the same Wi-Fi:
  a QR code, scanned with the phone's camera. Caprock shares that one server
  through a proxy on this computer's Wi-Fi address and a random port, behind a
  link only the QR carries; live reload works. Sharing stops on *Stop
  sharing*, after 30 minutes unused, after 8 hours, or when Caprock quits
  (ADR-087).
