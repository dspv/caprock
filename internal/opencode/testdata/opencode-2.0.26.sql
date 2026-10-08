PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_message VALUES('msg_11dc01b43001B1KW8SvNxyEeN8','ses_ee23fe547ffeGrZPc2puP1wUU1','user',4,1791500491631,1791500491632,'{"time":{"created":1791500491631},"text":"\"Please USE A TOOL to print hi\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc01b7b001uJxs1Tubz1eQWg','ses_ee23fe547ffeGrZPc2puP1wUU1','assistant',5,1791500491651,1791500491905,'{"time":{"created":1791500491651,"streamed":1791500491865,"completed":1791500491905},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00491653","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"echo hi > note.txt && echo hi","description":"Print hi"},"content":[{"type":"text","text":"hi\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1791500491860,"ran":1791500491864,"completed":1791500491903}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01c87001Cbp7VIFpjq4llp','ses_ee23fe547ffeGrZPc2puP1wUU1','assistant',14,1791500491918,1791500491933,'{"time":{"created":1791500491918,"streamed":1791500491927,"completed":1791500491932},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00491921","name":"read","executed":false,"state":{"status":"completed","input":{"path":"note.txt"},"content":[{"type":"text","text":"Read file note.txt, lines 1-1\n1: hi"}],"metadata":{"truncated":false}},"time":{"created":1791500491924,"ran":1791500491926,"completed":1791500491930}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01ca2001ycW29rY7NK6coe','ses_ee23fe547ffeGrZPc2puP1wUU1','assistant',21,1791500491944,1791500491952,'{"time":{"created":1791500491944,"streamed":1791500491951,"completed":1791500491952},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"text","text":"The command ran; it printed hi. Done. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01cb1002iI0FUyeSh1QEf1','ses_ee23fe547ffeGrZPc2puP1wUU1','idle',26,1791500491953,1791500491953,'{"time":{"created":1791500491953},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_11dc01eb00015LDWtrdfle3GiB','ses_ee23fe1e7ffeeiMs3y3TW987xd','user',4,1791500492510,1791500492511,'{"time":{"created":1791500492510},"text":"\"Please USE A SUBAGENT to look around\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc01ee9001zM23KqGAMXr1Kj','ses_ee23fe1e7ffeeiMs3y3TW987xd','assistant',5,1791500492528,1791500492591,'{"time":{"created":1791500492528,"streamed":1791500492541,"completed":1791500492590},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00492530","name":"subagent","executed":false,"state":{"status":"completed","input":{"agent":"general","description":"Look around","prompt":"List the files and summarise them."},"content":[{"type":"text","text":"<subagent sessionID=\"ses_ee23fe0f4ffeylWZL6V350JpvY\" state=\"completed\">\nHello from the fake model. The answer is 42. \n</subagent>"}],"metadata":{"sessionID":"ses_ee23fe0f4ffeylWZL6V350JpvY","status":"completed","truncated":false}},"time":{"created":1791500492535,"ran":1791500492539,"completed":1791500492589}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01f0f0021rdQbWov6c5RGh','ses_ee23fe0f4ffeylWZL6V350JpvY','user',4,1791500492566,1791500492566,'{"time":{"created":1791500492566},"text":"You are a subagent spawned by another session.\nList the files and summarise them."}');
INSERT INTO session_message VALUES('msg_11dc01f1a001En9hnw76hgFotj','ses_ee23fe0f4ffeylWZL6V350JpvY','assistant',5,1791500492577,1791500492586,'{"time":{"created":1791500492577,"streamed":1791500492585,"completed":1791500492586},"agent":"general","model":{"id":"m1","providerID":"fake"},"content":[{"type":"text","text":"Hello from the fake model. The answer is 42. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01f2b002mdbVPA7Zjw9K9W','ses_ee23fe0f4ffeylWZL6V350JpvY','idle',10,1791500492587,1791500492588,'{"time":{"created":1791500492587},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_11dc01f340014WYSvKMCGSUcZB','ses_ee23fe1e7ffeeiMs3y3TW987xd','assistant',14,1791500492602,1791500492610,'{"time":{"created":1791500492602,"streamed":1791500492609,"completed":1791500492609},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"text","text":"The command ran; it printed hi. Done. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc01f42002LgAkF2gknfLuP9','ses_ee23fe1e7ffeeiMs3y3TW987xd','idle',19,1791500492611,1791500492611,'{"time":{"created":1791500492611},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_11dc0213e0016E5JqhzpQu3YOL','ses_ee23fdf58ffew3vRe12Fd7Ah2n','user',4,1791500493164,1791500493165,'{"time":{"created":1791500493164},"text":"\"Please FAIL A TOOL now\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc02176001jjLUA6q2oCUd8e','ses_ee23fdf58ffew3vRe12Fd7Ah2n','assistant',5,1791500493181,1791500493202,'{"time":{"created":1791500493181,"streamed":1791500493193,"completed":1791500493202},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00493184","name":"read","executed":false,"state":{"status":"error","input":{"path":"/nonexistent/file.txt"},"error":{"type":"tool.execution","message":"File not found: /nonexistent/file.txt"}},"time":{"created":1791500493188,"ran":1791500493192,"completed":1791500493200}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc02197001Cae8xNytU78rQf','ses_ee23fdf58ffew3vRe12Fd7Ah2n','assistant',14,1791500493213,1791500493232,'{"time":{"created":1791500493213,"streamed":1791500493230,"completed":1791500493231},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"text","text":"The command ran; it printed hi. Done. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc021b1001vj7787TR6OVXY2','ses_ee23fdf58ffew3vRe12Fd7Ah2n','idle',19,1791500493233,1791500493233,'{"time":{"created":1791500493233},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_11dc023aa001b64COZFDDdk1wy','ses_caprockPlan0001','user',4,1791500493784,1791500493784,'{"time":{"created":1791500493784},"text":"\"Plan something\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc023e2001LHuDmhJBmzwjtz','ses_caprockPlan0001','assistant',6,1791500493803,1791500493817,'{"time":{"created":1791500493803,"streamed":1791500493815,"completed":1791500493816},"agent":"plan","model":{"id":"m2","providerID":"fake"},"content":[{"type":"text","text":"Hello from the fake model. The answer is 42. "}],"finish":"stop","rawFinish":"stop","cost":0.00117,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc023e3001ekJJbuInVZZwHd','ses_caprockPlan0001','synthetic',11,1791500493820,1791500493820,'{"time":{"created":1791500493820},"text":"<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:\n/home/dev/.opencode/plan\n\nDo not modify any other files or ask a subagent to do so.\n\nYou remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.\n</system-reminder>"}');
INSERT INTO session_message VALUES('msg_11dc023ff001QwlhDSqyHwUdVo','ses_caprockPlan0001','assistant',14,1791500493829,1791500493852,'{"time":{"created":1791500493829,"streamed":1791500493851,"completed":1791500493852},"agent":"plan","model":{"id":"m2","providerID":"fake"},"content":[{"type":"text","text":"Hello from the fake model. The answer is 42. "}],"finish":"stop","rawFinish":"stop","cost":0.00117,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc0241d001uUKT7C1IV89RrU','ses_caprockPlan0001','idle',19,1791500493853,1791500493854,'{"time":{"created":1791500493853},"outcome":"succeeded"}');
CREATE TABLE `session_v2` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `fork_session_id` text,
          `fork_boundary` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_idle` integer,
          `time_viewed` integer,
          `idle_outcome` text,
          `time_compacting` integer,
          `time_archived` integer,
          `time_suspended` integer,
          `resume_attempts` integer DEFAULT 0 NOT NULL,
          CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_v2 VALUES('ses_ee23fe547ffeGrZPc2puP1wUU1','8c7be089f453473f677616cd2481db433813236e',NULL,NULL,NULL,NULL,'tidy-squid','/home/dev/proj','','Fake session title','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.01428,4000,136,0,800,0,NULL,NULL,NULL,NULL,1791500491579,1791500491952,1791500491953,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_ee23fe1e7ffeeiMs3y3TW987xd','8c7be089f453473f677616cd2481db433813236e',NULL,NULL,NULL,NULL,'hidden-comet','/home/dev/proj','','Fake session title','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.010709999999999999,3000,102,0,600,0,NULL,NULL,NULL,NULL,1791500492456,1791500492609,1791500492611,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_ee23fe0f4ffeylWZL6V350JpvY','8c7be089f453473f677616cd2481db433813236e',NULL,'ses_ee23fe1e7ffeeiMs3y3TW987xd',NULL,NULL,'stellar-mountain','/home/dev/proj','','Look around','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.00357,1000,34,0,200,0,NULL,NULL,'general',NULL,1791500492557,1791500492586,1791500492587,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_ee23fdf58ffew3vRe12Fd7Ah2n','8c7be089f453473f677616cd2481db433813236e',NULL,NULL,NULL,NULL,'calm-circuit','/home/dev/proj','','Fake session title','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.010709999999999999,3000,102,0,600,0,NULL,NULL,NULL,NULL,1791500493109,1791500493231,1791500493233,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_caprockPlan0001','8c7be089f453473f677616cd2481db433813236e',NULL,NULL,NULL,NULL,'curious-meadow','/home/dev/proj','','Fake session title','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.00351,3000,102,0,600,0,NULL,NULL,NULL,NULL,1791500493730,1791500493852,1791500493853,NULL,'succeeded',NULL,NULL,NULL,0);
COMMIT;
