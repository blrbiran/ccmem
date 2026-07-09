---
description: Run ccmem admin commands
command: true
disable-model-invocation: true
argument-hint: "daemon <start|stop|restart|status|install|uninstall> | cron <list [--issues|--history N --task TYPE] [--verbose] | run <daily_maintenance|weekly_synthesis|security_audit|contradiction_audit|monthly_meta_synthesis|revalidation_audit|vec_backfill>> | semantic <on|off|status> [--provider <transformers-local|openai|jina>] | retrieval-check [--corpus <path>] [--k 1,3,5] | diagnose [--retrieval] [--embedding-circuit <open|close|status>] [--migrations|--key|--sessions|--security|--tuning|--metrics [--days N]|--synthesis] | alias <old-project-key> <new-project-key>"
---

ccmem admin -- $ARGUMENTS
