# Benchmarks, 2026-10-06

MacBookPro18,3 (Apple M1 Pro, 10 cores, 16 GB), macOS 27.0.1 (26A434), display 1920x1080@1x 100Hz, Now drawing from 'AC Power'. Runs started 2026-10-06 01:45 UTC, 2026-10-06 01:58 UTC, 2026-10-06 02:37 UTC.

| Metric | Budget | run 1 | run 2 | run 3 | Verdict |
|---|---|---|---|---|---|
| Echo p50, any load to 1000 lines/s | ≤ 12 ms | 13 ms | 11 ms | 15 ms | mixed |
| Echo p95, any load to 1000 lines/s | ≤ 25 ms | 25 ms | 19 ms | 27 ms | mixed |
| Echo p95 in tab A while tab B floods | ≤ 25 ms | 17 ms | 18 ms | 17 ms | pass |
| Open a session, click to first echo, p50 | ≤ 200 ms | 114 ms | 113 ms | 115 ms | pass |
| Switch to an open tab, to first paint | ≤ 50 ms | 39 ms | 38 ms | 40 ms | pass |
| Cold start to interactive window | ≤ 1.5 s | 1.09 s | 1.07 s | 1.12 s | pass |
| Cold start to first echo in a restored tab | ≤ 2.5 s | 1.41 s | 1.43 s | 1.43 s | pass |
| Memory, all app processes, 1 tab (footprint) | ≤ 250 MB | 197.4 MB | 198.9 MB | 198.4 MB | pass |
| Memory, all app processes, 10 tabs (footprint) | ≤ 450 MB | 315 MB | 307.4 MB | 303.4 MB | pass |
| CPU, window visible, no output | ≤ 1% of one core | 1.1 % | 0.93 % | 0.95 % | mixed |
| CPU, window hidden | ≤ 0.2% of one core | 1 % | 0.96 % | 1.3 % | fail |
| CPU, one visible tab at 1000 lines/s | ≤ 25% of one core | 17.7 % | 17.5 % | 18.4 % | pass |
| UI long task during the benchmark | none over 100 ms | 154 ms | 71 ms | 146 ms | mixed |
| Daemon restart to live terminal | ≤ 2 s | 476 ms | 413 ms | 452 ms | pass |
| Network back to live terminal (phone) | ≤ 3 s median | 60 ms | 59 ms | 58 ms | pass |
| Half-open connection detected | ≤ 25 s | 24.53 s | 24.95 s | 24.36 s | pass |
| Disk written by the app, per day | ≤ 10 MB | 0.0 MB | 0.0 MB | 0.0 MB | pass |
| Download size, per OS (macOS, Caprock_0.77.0_universal.dmg) | ≤ 60 MB | 17.4 MB | – | – | pass |

Also measured (no budget row):

- app-r1: memory (footprint) 5 tabs 257.1 MB, 10 tabs after 40 s 296.3 MB; summed RSS (peak) 1/5/10 tabs 318.8 MB / 365.1 MB / 408.8 MB; open p95 252 ms; switch p95 58 ms; CPU spinner only (visible) 7.2 %, hidden with spinners 1.9 %; disk in the first two minutes 1.4 MB; first launch of a new copy 1.90 s
  - echo at 0 lines/s: p50 13 ms, p95 25 ms, max 35 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 13 ms, p95 21 ms, max 29 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 12 ms, p95 24 ms, max 91 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r2: memory (footprint) 5 tabs 256.6 MB, 10 tabs after 40 s 305.7 MB; summed RSS (peak) 1/5/10 tabs 287.8 MB / 356.8 MB / 401.6 MB; open p95 127 ms; switch p95 44 ms; CPU spinner only (visible) 7.4 %, hidden with spinners 2.2 %; disk in the first two minutes 1.2 MB; first launch of a new copy 994 ms
  - echo at 0 lines/s: p50 11 ms, p95 18 ms, max 24 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 11 ms, p95 19 ms, max 22 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 11 ms, p95 17 ms, max 22 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r3: memory (footprint) 5 tabs 261 MB, 10 tabs after 40 s 307.9 MB; summed RSS (peak) 1/5/10 tabs 347 MB / 290.5 MB / 255 MB; open p95 243 ms; switch p95 57 ms; CPU spinner only (visible) 7.0 %, hidden with spinners 1.9 %; disk in the first two minutes 1.3 MB; first launch of a new copy 1.73 s
  - echo at 0 lines/s: p50 15 ms, p95 27 ms, max 42 ms, socket p50 3 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 13 ms, p95 26 ms, max 42 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 11 ms, p95 19 ms, max 26 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- phone-r1: chat open on wifi: p50 47 ms, p95 51 ms ([51, 46, 47, 46, 47, 46, 48, 45])
- phone-r1: chat open on cellular: p50 147 ms, p95 148 ms ([146, 146, 147, 148, 148, 147, 146, 145])
- phone-r1: back to live p95 761 ms, max 763 ms, failed 0
  - wifi_off (5 s): 62 ms
  - wifi_off (5 s): 60 ms
  - wifi_off (5 s): 45 ms
  - wifi_off (5 s): 62 ms
  - wifi_off (5 s): 68 ms
  - airplane (60 s): 57 ms
  - wifi_to_cellular (0 s): 387 ms
  - wifi_to_cellular (0 s): 390 ms
  - wifi_to_cellular (0 s): 761 ms
  - wifi_to_cellular (0 s): 397 ms
  - wifi_to_cellular (0 s): 763 ms
  - stall (10 s): 14 ms
  - stall (10 s): 12 ms
  - stall (10 s): 14 ms
  - stall (10 s): 28 ms
  - stall (10 s): 23 ms
  - half_open (40 s): 59 ms, detected after 24.23 s, redialled after 24.73 s
  - half_open (40 s): 52 ms, detected after 24.53 s, redialled after 25.04 s
- phone-r2: chat open on wifi: p50 46 ms, p95 60 ms ([56, 44, 46, 51, 44, 60, 39, 44])
- phone-r2: chat open on cellular: p50 161 ms, p95 164 ms ([161, 163, 162, 149, 159, 146, 164, 145])
- phone-r2: back to live p95 403 ms, max 404 ms, failed 0
  - wifi_off (5 s): 59 ms
  - wifi_off (5 s): 54 ms
  - wifi_off (5 s): 59 ms
  - wifi_off (5 s): 60 ms
  - wifi_off (5 s): 58 ms
  - airplane (60 s): 73 ms
  - wifi_to_cellular (0 s): 404 ms
  - wifi_to_cellular (0 s): 403 ms
  - wifi_to_cellular (0 s): 390 ms
  - wifi_to_cellular (0 s): 399 ms
  - wifi_to_cellular (0 s): 402 ms
  - stall (10 s): 13 ms
  - stall (10 s): 23 ms
  - stall (10 s): 28 ms
  - stall (10 s): 28 ms
  - stall (10 s): 20 ms
  - half_open (40 s): 60 ms, detected after 24.95 s, redialled after 25.45 s
  - half_open (40 s): 59 ms, detected after 24.25 s, redialled after 24.75 s
- phone-r3: chat open on wifi: p50 46 ms, p95 64 ms ([64, 44, 47, 46, 44, 46, 47, 45])
- phone-r3: chat open on cellular: p50 162 ms, p95 163 ms ([163, 162, 162, 162, 145, 145, 149, 146])
- phone-r3: back to live p95 404 ms, max 408 ms, failed 0
  - wifi_off (5 s): 70 ms
  - wifi_off (5 s): 60 ms
  - wifi_off (5 s): 58 ms
  - wifi_off (5 s): 54 ms
  - wifi_off (5 s): 57 ms
  - airplane (60 s): 68 ms
  - wifi_to_cellular (0 s): 401 ms
  - wifi_to_cellular (0 s): 404 ms
  - wifi_to_cellular (0 s): 403 ms
  - wifi_to_cellular (0 s): 408 ms
  - wifi_to_cellular (0 s): 394 ms
  - stall (10 s): 24 ms
  - stall (10 s): 18 ms
  - stall (10 s): 27 ms
  - stall (10 s): 22 ms
  - stall (10 s): 25 ms
  - half_open (40 s): 57 ms, detected after 24.02 s, redialled after 24.52 s
  - half_open (40 s): 52 ms, detected after 24.36 s, redialled after 24.86 s

- app-r1: 1-minute load average before each phase 4.8–45.9 on 10 cores
- app-r2: 1-minute load average before each phase 3.3–5.5 on 10 cores
- app-r3: 1-minute load average before each phase 5.0–47.1 on 10 cores
- phone-r1: 1-minute load average before each phase 4.5–5.2 on 10 cores
- phone-r2: 1-minute load average before each phase 4.5–5.5 on 10 cores
- phone-r3: 1-minute load average before each phase 5.8–6.0 on 10 cores
