---
status: proposed
scope: Schway host contract
---

# เสนอ public host contract ที่แคบสำหรับ Jit

Schway มี loop/session/context/provider implementations แต่ public stable entry มีเฉพาะ extensions ขณะที่ Jit ต้องเลือก tools และ trusted context sources รวมทั้งจัดการ independent runs จึงเสนอ public embedding contract ที่แคบ โดยรักษา loop, retries และ native conversation ownership ของ Schway

การเปิด source functions ทุกตัวหรือใช้ private deep imports ทำได้เร็วกว่าแต่ผูก Jit กับ internals การครอบ CLI JSONL ช่วย prototype ได้แต่ยังไม่พิสูจน์การคุม instructions, registry และ recovery ตาม PRD โดยเฉพาะ context manager ที่ค้นหา AGENTS.md/skills จาก workspace อัตโนมัติ

Contract ต้องครอบคลุม capability/version discovery, session/run lifecycle, host-controlled instruction/skill/package sources, scoped tool selection, opaque credential management และ durable outcome references โดยไม่โหลด TUI และไม่โหลด provider ที่ไม่เลือก ชื่อ exports กับ schema ยังไม่ล็อก

ก่อนเปลี่ยนเป็น accepted ต้องมี API spec, compatibility tests และ review ตาม process Schway สถานะ proposed นี้ไม่อนุมัติให้ขยาย runtime จากงานเอกสาร

หลักฐาน: [stability](../stability.md), [context manager](../../src/context/manager.ts), [Jit architecture](https://github.com/chayapats/jit/blob/main/docs/product/03-architecture.md)

Tracked spec: [S02](https://github.com/chayapats/schway/issues/393). Product and memory/job decisions live in the Jit repository.
