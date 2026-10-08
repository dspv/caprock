PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
INSERT INTO message VALUES('msg_11dc0b7410017kTOc8H1lLx2Ro','ses_ee23f48fafferHslj7rwP1LkA5',1791500531521,1791500531851,'{"role":"user","time":{"created":1791500531521},"agent":"build","model":{"providerID":"fake","modelID":"m1"},"summary":{"diffs":[]}}');
INSERT INTO message VALUES('msg_11dc0b7dc001w2o4HJ921372E2','ses_ee23f48fafferHslj7rwP1LkA5',1791500531676,1791500531802,'{"parentID":"msg_11dc0b7410017kTOc8H1lLx2Ro","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/dev/proj","root":"/"},"cost":0.00357,"tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"modelID":"m1","providerID":"fake","time":{"created":1791500531676,"completed":1791500531802},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_11dc0b85c001cA336Upgf5ouH9','ses_ee23f48fafferHslj7rwP1LkA5',1791500531805,1791500531843,'{"parentID":"msg_11dc0b7410017kTOc8H1lLx2Ro","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/dev/proj","root":"/"},"cost":0.00357,"tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"modelID":"m1","providerID":"fake","time":{"created":1791500531805,"completed":1791500531842},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_11dc0b885001JwsqYzBEsi74Ue','ses_ee23f48fafferHslj7rwP1LkA5',1791500531845,1791500531864,'{"parentID":"msg_11dc0b7410017kTOc8H1lLx2Ro","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/dev/proj","root":"/"},"cost":0.00357,"tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"modelID":"m1","providerID":"fake","time":{"created":1791500531845,"completed":1791500531863},"finish":"stop"}');
CREATE TABLE `part` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
INSERT INTO part VALUES('prt_11dc0b746001CEELJ5SQMcJuhz','msg_11dc0b7410017kTOc8H1lLx2Ro','ses_ee23f48fafferHslj7rwP1LkA5',1791500531532,1791500531532,'{"type":"text","text":"\"Please USE A TOOL to print hi\""}');
INSERT INTO part VALUES('prt_11dc0b81d001FFkM6UwLgYINfA','msg_11dc0b7dc001w2o4HJ921372E2','ses_ee23f48fafferHslj7rwP1LkA5',1791500531741,1791500531742,'{"type":"step-start"}');
INSERT INTO part VALUES('prt_11dc0b81f0016FI07qVccr0M15','msg_11dc0b7dc001w2o4HJ921372E2','ses_ee23f48fafferHslj7rwP1LkA5',1791500531744,1791500531796,'{"type":"tool","tool":"bash","callID":"call_00531738","state":{"status":"completed","input":{"command":"echo hi > note.txt && echo hi","description":"Print hi"},"output":"hi\n","metadata":{"output":"hi\n","exit":0,"description":"Print hi","truncated":false},"title":"Print hi","time":{"start":1791500531791,"end":1791500531796}}}');
INSERT INTO part VALUES('prt_11dc0b857001o4Ju4p0ZYvQ99q','msg_11dc0b7dc001w2o4HJ921372E2','ses_ee23f48fafferHslj7rwP1LkA5',1791500531799,1791500531799,'{"reason":"tool-calls","type":"step-finish","tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"cost":0.00357}');
INSERT INTO part VALUES('prt_11dc0b8750011ehYsLoJjiH9Az','msg_11dc0b85c001cA336Upgf5ouH9','ses_ee23f48fafferHslj7rwP1LkA5',1791500531829,1791500531830,'{"type":"step-start"}');
INSERT INTO part VALUES('prt_11dc0b8760014oS8GqUTlnYLlu','msg_11dc0b85c001cA336Upgf5ouH9','ses_ee23f48fafferHslj7rwP1LkA5',1791500531830,1791500531839,'{"type":"tool","tool":"read","callID":"call_00531828","state":{"status":"error","input":{"path":"note.txt"},"error":"The read tool was called with invalid arguments: SchemaError(Missing key\n  at [\"filePath\"]).\nPlease rewrite the input so it satisfies the expected schema.","time":{"start":1791500531835,"end":1791500531838}}}');
INSERT INTO part VALUES('prt_11dc0b880001qmc307GMJkKuQZ','msg_11dc0b85c001cA336Upgf5ouH9','ses_ee23f48fafferHslj7rwP1LkA5',1791500531840,1791500531841,'{"reason":"tool-calls","type":"step-finish","tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"cost":0.00357}');
INSERT INTO part VALUES('prt_11dc0b8910016pzJrmwevlvZpU','msg_11dc0b885001JwsqYzBEsi74Ue','ses_ee23f48fafferHslj7rwP1LkA5',1791500531857,1791500531858,'{"type":"step-start"}');
INSERT INTO part VALUES('prt_11dc0b8920015kbdQyHFpWh2Af','msg_11dc0b885001JwsqYzBEsi74Ue','ses_ee23f48fafferHslj7rwP1LkA5',1791500531858,1791500531861,'{"type":"text","text":"The command ran; it printed hi. Done. ","time":{"start":1791500531858,"end":1791500531861}}');
INSERT INTO part VALUES('prt_11dc0b8960012ywB7FHBUaL6K0','msg_11dc0b885001JwsqYzBEsi74Ue','ses_ee23f48fafferHslj7rwP1LkA5',1791500531862,1791500531862,'{"reason":"stop","type":"step-finish","tokens":{"total":1234,"input":1000,"output":34,"reasoning":0,"cache":{"write":0,"read":200}},"cost":0.00357}');
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`share_url` text,
	`summary_additions` integer,
	`summary_deletions` integer,
	`summary_files` integer,
	`summary_diffs` text,
	`revert` text,
	`permission` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_compacting` integer,
	`time_archived` integer, `workspace_id` text, `path` text, `agent` text, `model` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `metadata` text,
	CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
INSERT INTO session VALUES('ses_ee23f48fafferHslj7rwP1LkA5','global',NULL,'glowing-wolf','/home/dev/proj','Fake session title','1.15.10',NULL,0,0,0,NULL,NULL,'[{"permission":"question","pattern":"*","action":"deny"},{"permission":"plan_enter","pattern":"*","action":"deny"},{"permission":"plan_exit","pattern":"*","action":"deny"}]',1791500531462,1791500531848,NULL,NULL,NULL,'home/dev/proj','build','{"id":"m1","providerID":"fake","variant":"default"}',0.010709999999999999,3000,102,0,600,0,NULL);
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
          `time_compacting` integer,
          `time_archived` integer,
          `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text,
          CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_v2 VALUES('ses_ee23f48fafferHslj7rwP1LkA5','global',NULL,NULL,NULL,NULL,'glowing-wolf','/home/dev/proj','home/dev/proj','Fake session title','1.15.10',NULL,0,0,0,NULL,NULL,0.01428,4000,136,0,800,0,NULL,NULL,'build','{"id":"m1","providerID":"fake","variant":"default"}',1791500531462,1791500541274,NULL,NULL,NULL,0,1791500541275,NULL,'succeeded');
INSERT INTO session_v2 VALUES('ses_ee23f2130ffeQJ1hVVb2kYmDG5','ba0fd6ff23c8f3662c030d42d8d852baed2c5ee9',NULL,NULL,NULL,NULL,'neon-wizard','/home/dev/proj','','Fake session title','2.0.26',NULL,NULL,NULL,NULL,NULL,NULL,0.01428,4000,136,0,800,0,NULL,NULL,NULL,NULL,1791500541787,1791500541950,NULL,NULL,NULL,0,1791500541952,NULL,'succeeded');
CREATE TABLE IF NOT EXISTS "session_message" (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_message VALUES('msg_11dc0b7410017kTOc8H1lLx2Ro','ses_ee23f48fafferHslj7rwP1LkA5','user',0,1791500531521,1791500531851,'{"text":"\"Please USE A TOOL to print hi\"","time":{"created":1791500531521}}');
INSERT INTO session_message VALUES('msg_11dc0b7dc001w2o4HJ921372E2','ses_ee23f48fafferHslj7rwP1LkA5','assistant',1,1791500531676,1791500531802,'{"agent":"build","model":{"providerID":"fake","id":"m1","variant":"default"},"content":[{"type":"tool","id":"call_00531738","name":"bash","state":{"status":"completed","input":{"command":"echo hi > note.txt && echo hi","description":"Print hi"},"content":[{"type":"text","text":"hi\n"}],"metadata":{"output":"hi\n","exit":0,"description":"Print hi","truncated":false}},"time":{"created":1791500531791,"completed":1791500531796}}],"finish":"tool-calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}},"time":{"created":1791500531676,"completed":1791500531802}}');
INSERT INTO session_message VALUES('msg_11dc0b85c001cA336Upgf5ouH9','ses_ee23f48fafferHslj7rwP1LkA5','assistant',2,1791500531805,1791500531843,'{"agent":"build","model":{"providerID":"fake","id":"m1","variant":"default"},"content":[{"type":"tool","id":"call_00531828","name":"read","state":{"status":"error","input":{"path":"note.txt"},"error":{"type":"tool.execution","message":"The read tool was called with invalid arguments: SchemaError(Missing key\n  at [\"filePath\"]).\nPlease rewrite the input so it satisfies the expected schema."}},"time":{"created":1791500531835,"completed":1791500531838}}],"finish":"tool-calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}},"time":{"created":1791500531805,"completed":1791500531843}}');
INSERT INTO session_message VALUES('msg_11dc0b885001JwsqYzBEsi74Ue','ses_ee23f48fafferHslj7rwP1LkA5','assistant',3,1791500531845,1791500531864,'{"agent":"build","model":{"providerID":"fake","id":"m1","variant":"default"},"content":[{"type":"text","text":"The command ran; it printed hi. Done. "}],"finish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}},"time":{"created":1791500531845,"completed":1791500531864}}');
INSERT INTO session_message VALUES('msg_11dc0b885001W9mhAc2rbEkqP6','ses_ee23f48fafferHslj7rwP1LkA5','system',4,1791500531845,1791500531864,'{"text":"The available tools have changed.\n\nThe `bash` tool is now `shell` and must be called by that name.\n\nThe `read` tool now takes `path` instead of `filePath`.","time":{"created":1791500531845}}');
INSERT INTO session_message VALUES('msg_11dc0dc23001HZ3NCrWcoDbHAz','ses_ee23f48fafferHslj7rwP1LkA5','agent-switched',5,1791500540963,1791500540964,'{"time":{"created":1791500540963},"agent":"build","previous":"build"}');
INSERT INTO session_message VALUES('msg_11dc0dc200017ju17DvLSOufSM','ses_ee23f48fafferHslj7rwP1LkA5','user',9,1791500541245,1791500541246,'{"time":{"created":1791500541245},"text":"\"Continue this in v2\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc0dd44001AQQsWS3CMbLCyA','ses_ee23f48fafferHslj7rwP1LkA5','assistant',10,1791500541260,1791500541274,'{"time":{"created":1791500541260,"streamed":1791500541273,"completed":1791500541274},"agent":"build","model":{"id":"m1","providerID":"fake","variant":"default"},"content":[{"type":"text","text":"Hello from the fake model. The answer is 42. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc0dd5b002IunHCACNy44JdY','ses_ee23f48fafferHslj7rwP1LkA5','idle',15,1791500541275,1791500541275,'{"time":{"created":1791500541275},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_11dc0df65001ZHqdbnRJ25n8VY','ses_ee23f2130ffeQJ1hVVb2kYmDG5','user',4,1791500541841,1791500541841,'{"time":{"created":1791500541841},"text":"\"Please USE A TOOL in v2\"","files":[]}');
INSERT INTO session_message VALUES('msg_11dc0df9c0012luo4v0BBo5yZD','ses_ee23f2130ffeQJ1hVVb2kYmDG5','assistant',5,1791500541858,1791500541908,'{"time":{"created":1791500541858,"streamed":1791500541870,"completed":1791500541908},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00541861","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"echo hi > note.txt && echo hi","description":"Print hi"},"content":[{"type":"text","text":"hi\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1791500541866,"ran":1791500541869,"completed":1791500541906}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc0dfda001e2nI7eHU89Nzs3','ses_ee23f2130ffeQJ1hVVb2kYmDG5','assistant',14,1791500541920,1791500541932,'{"time":{"created":1791500541920,"streamed":1791500541928,"completed":1791500541932},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"tool","id":"call_00541922","name":"read","executed":false,"state":{"status":"completed","input":{"path":"note.txt"},"content":[{"type":"text","text":"Read file note.txt, lines 1-1\n1: hi"}],"metadata":{"truncated":false}},"time":{"created":1791500541924,"ran":1791500541927,"completed":1791500541931}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc0dff2001AdBLTgDop9eKM2','ses_ee23f2130ffeQJ1hVVb2kYmDG5','assistant',21,1791500541943,1791500541950,'{"time":{"created":1791500541943,"streamed":1791500541949,"completed":1791500541950},"agent":"build","model":{"id":"m1","providerID":"fake"},"content":[{"type":"text","text":"The command ran; it printed hi. Done. "}],"finish":"stop","rawFinish":"stop","cost":0.00357,"tokens":{"input":1000,"output":34,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO session_message VALUES('msg_11dc0e000001LMLjD41pUMwQV5','ses_ee23f2130ffeQJ1hVVb2kYmDG5','idle',26,1791500541952,1791500541952,'{"time":{"created":1791500541952},"outcome":"succeeded"}');
COMMIT;
