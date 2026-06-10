---
description: Run ccmem admin commands
command: true
disable-model-invocation: true
argument-hint: "daemon <start|stop|restart|status|install|uninstall> | cron <list [--issues|--history N --task TYPE] | run <daily_maintenance|weekly_synthesis|security_audit|revalidation_audit|vec_backfill>> | semantic <on|off|status> | diagnose [--migrations|--key|--sessions|--security|--tuning|--metrics [--days N]]"
---

ccmem admin -- $ARGUMENTS
