# Benchmarks, 2026-10-06

MacBookPro18,3 (Apple M1 Pro, 10 cores, 16 GB), macOS 27.0.1 (26A434), display 1920x1080@1x 100Hz, Now drawing from 'AC Power'. Runs started 2026-10-06 04:35 UTC, 2026-10-06 04:49 UTC, 2026-10-06 05:03 UTC.

| Metric                                                      | Budget             | run 1    | run 2    | run 3    | Verdict |
| ----------------------------------------------------------- | ------------------ | -------- | -------- | -------- | ------- |
| Echo p50, any load to 1000 lines/s                          | ≤ 12 ms            | 12 ms    | 12 ms    | 13 ms    | mixed   |
| Echo p95, any load to 1000 lines/s                          | ≤ 25 ms            | 19 ms    | 19 ms    | 19 ms    | pass    |
| Echo p95 in tab A while tab B floods                        | ≤ 25 ms            | 16 ms    | 17 ms    | 19 ms    | pass    |
| Open a session, click to first echo, p50                    | ≤ 200 ms           | 113 ms   | 112 ms   | 114 ms   | pass    |
| Switch to an open tab, to first paint                       | ≤ 50 ms            | 38 ms    | 38 ms    | 38 ms    | pass    |
| Cold start to interactive window                            | ≤ 1.5 s            | 1.07 s   | 1.09 s   | 1.38 s   | pass    |
| Cold start to first echo in a restored tab                  | ≤ 2.5 s            | 1.46 s   | 1.50 s   | 1.48 s   | pass    |
| Memory, all app processes, 1 tab (footprint)                | ≤ 250 MB           | 178.5 MB | 179.6 MB | 184 MB   | pass    |
| Memory, all app processes, 10 tabs (footprint)              | ≤ 450 MB           | 289.6 MB | 288.5 MB | 283.7 MB | pass    |
| CPU, window visible, no output                              | ≤ 1% of one core   | 0.85 %   | 0.79 %   | 0.70 %   | pass    |
| CPU, window hidden                                          | ≤ 0.2% of one core | 0.30 %   | 0.34 %   | 0.31 %   | fail    |
| CPU, one visible tab at 1000 lines/s                        | ≤ 25% of one core  | 17.7 %   | 18.2 %   | 18.3 %   | pass    |
| UI long task during the benchmark                           | none over 100 ms   | 134 ms   | 122 ms   | 69 ms    | mixed   |
| Daemon restart to live terminal                             | ≤ 2 s              | 429 ms   | 455 ms   | 431 ms   | pass    |
| Network back to live terminal (phone)                       | ≤ 3 s median       | 59 ms    | 64 ms    | 64 ms    | pass    |
| Half-open connection detected                               | ≤ 25 s             | 23.06 s  | 22.18 s  | 22.11 s  | pass    |
| Disk written by the app, per day                            | ≤ 10 MB            | 0.0 MB   | 0.0 MB   | 0.0 MB   | pass    |
| Download size, per OS (macOS, Caprock_0.77.0_universal.dmg) | ≤ 60 MB            | 17.4 MB  | –        | –        | pass    |

Also measured (no budget row):

- app-r1: memory (footprint) 5 tabs 244.8 MB, 10 tabs after 40 s 288.6 MB; summed RSS (peak) 1/5/10 tabs 374.4 MB / 369.8 MB / 414.6 MB; open p95 233 ms; switch p95 47 ms; CPU spinner only (visible) 7.8 %, hidden with spinners 1.1 %; disk in the first two minutes 1.7 MB; first launch of a new copy 1.70 s
  - echo at 0 lines/s: p50 12 ms, p95 19 ms, max 22 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 10 ms, p95 19 ms, max 29 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 12 ms, p95 19 ms, max 22 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r2: memory (footprint) 5 tabs 244 MB, 10 tabs after 40 s 288.2 MB; summed RSS (peak) 1/5/10 tabs 338.8 MB / 373.1 MB / 414.7 MB; open p95 230 ms; switch p95 46 ms; CPU spinner only (visible) 7.6 %, hidden with spinners 1.1 %; disk in the first two minutes 1.3 MB; first launch of a new copy 1.47 s
  - echo at 0 lines/s: p50 12 ms, p95 17 ms, max 24 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 11 ms, p95 19 ms, max 25 ms, socket p50 1 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 11 ms, p95 18 ms, max 25 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r3: memory (footprint) 5 tabs 237.2 MB, 10 tabs after 40 s 288.7 MB; summed RSS (peak) 1/5/10 tabs 357 MB / 375.4 MB / 405.7 MB; open p95 179 ms; switch p95 46 ms; CPU spinner only (visible) 7.7 %, hidden with spinners 1.3 %; disk in the first two minutes 1.4 MB; first launch of a new copy 1.31 s
  - echo at 0 lines/s: p50 13 ms, p95 19 ms, max 27 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 11 ms, p95 19 ms, max 28 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 10 ms, p95 18 ms, max 25 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- phone-r1: chat open on wifi: p50 46 ms, p95 52 ms ([52, 45, 47, 45, 46, 46, 47, 45])
- phone-r1: chat open on cellular: p50 162 ms, p95 163 ms ([163, 161, 163, 162, 145, 146, 148, 163])
- phone-r1: back to live p95 395 ms, max 395 ms, failed 0
  - wifi_off (5 s): 58 ms
  - wifi_off (5 s): 56 ms
  - wifi_off (5 s): 62 ms
  - wifi_off (5 s): 59 ms
  - wifi_off (5 s): 60 ms
  - airplane (60 s): 62 ms
  - wifi_to_cellular (0 s): 394 ms
  - wifi_to_cellular (0 s): 392 ms
  - wifi_to_cellular (0 s): 395 ms
  - wifi_to_cellular (0 s): 394 ms
  - wifi_to_cellular (0 s): 395 ms
  - stall (10 s): 27 ms
  - stall (10 s): 26 ms
  - stall (10 s): 22 ms
  - stall (10 s): 12 ms
  - stall (10 s): 31 ms
  - half_open (40 s): 46 ms, detected after 23.06 s, redialled after 23.06 s
  - half_open (40 s): 46 ms, detected after 22.64 s, redialled after 22.64 s
- phone-r2: chat open on wifi: p50 47 ms, p95 69 ms ([69, 45, 45, 47, 46, 44, 47, 47])
- phone-r2: chat open on cellular: p50 147 ms, p95 163 ms ([162, 163, 145, 162, 147, 146, 146, 145])
- phone-r2: back to live p95 763 ms, max 775 ms, failed 0
  - wifi_off (5 s): 71 ms
  - wifi_off (5 s): 62 ms
  - wifi_off (5 s): 64 ms
  - wifi_off (5 s): 73 ms
  - wifi_off (5 s): 59 ms
  - airplane (60 s): 74 ms
  - wifi_to_cellular (0 s): 412 ms
  - wifi_to_cellular (0 s): 406 ms
  - wifi_to_cellular (0 s): 391 ms
  - wifi_to_cellular (0 s): 763 ms
  - wifi_to_cellular (0 s): 775 ms
  - stall (10 s): 27 ms
  - stall (10 s): 14 ms
  - stall (10 s): 29 ms
  - stall (10 s): 27 ms
  - stall (10 s): 21 ms
  - half_open (40 s): 53 ms, detected after 22.18 s, redialled after 22.18 s
  - half_open (40 s): 43 ms, detected after 21.89 s, redialled after 21.89 s
- phone-r3: chat open on wifi: p50 46 ms, p95 62 ms ([62, 46, 46, 45, 44, 44, 47, 45])
- phone-r3: chat open on cellular: p50 161 ms, p95 162 ms ([161, 147, 161, 146, 147, 162, 146, 161])
- phone-r3: back to live p95 399 ms, max 401 ms, failed 0
  - wifi_off (5 s): 66 ms
  - wifi_off (5 s): 64 ms
  - wifi_off (5 s): 64 ms
  - wifi_off (5 s): 65 ms
  - wifi_off (5 s): 31 ms
  - airplane (60 s): 76 ms
  - wifi_to_cellular (0 s): 401 ms
  - wifi_to_cellular (0 s): 399 ms
  - wifi_to_cellular (0 s): 398 ms
  - wifi_to_cellular (0 s): 399 ms
  - wifi_to_cellular (0 s): 398 ms
  - stall (10 s): 15 ms
  - stall (10 s): 33 ms
  - stall (10 s): 17 ms
  - stall (10 s): 14 ms
  - stall (10 s): 17 ms
  - half_open (40 s): 45 ms, detected after 22.11 s, redialled after 22.11 s
  - half_open (40 s): 63 ms, detected after 21.89 s, redialled after 21.89 s

- app-r1: 1-minute load average before each phase 2.3–6.1 on 10 cores
- app-r2: 1-minute load average before each phase 3.1–5.6 on 10 cores
- app-r3: 1-minute load average before each phase 5.6–6.8 on 10 cores
- phone-r1: 1-minute load average before each phase 3.5–4.4 on 10 cores
- phone-r2: 1-minute load average before each phase 4.5–5.0 on 10 cores
- phone-r3: 1-minute load average before each phase 5.7–6.1 on 10 cores
