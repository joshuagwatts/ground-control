import test from "node:test";
import assert from "node:assert/strict";
import { buildLeadSmsBody } from "../www/homeowner/crm.js";

test("lead sms: full lead reads like a text and stays compact", () => {
  const body = buildLeadSmsBody({
    name: "Jordan Smith",
    address: "3808 NW 67th St, Oklahoma City, OK 73116",
    phone: "(405) 555-0100",
    roofAgeLabel: "5–10 years",
    rec: { headline: "Hail storms over this home — get it inspected" },
    storms: [
      { date: "2026-03-10", maxSizeIn: 1.75 },
      { date: "2025-10-23", maxSizeIn: 1.0 },
      { date: "2024-05-08", maxSizeIn: 0.75 },
    ],
  });
  assert.match(body, /Jordan Smith/);
  assert.match(body, /3808 NW 67th St/);
  assert.match(body, /3 covering storms, 2 at 1"\+/);
  assert.match(body, /5–10 years/);
  assert.match(body, /\(405\) 555-0100/);
  assert.match(body, /free inspection/);
  assert.ok(body.length <= 480, `body too long: ${body.length}`);
});

test("lead sms: singular storm grammar", () => {
  const body = buildLeadSmsBody({ storms: [{ date: "2025-10-23", maxSizeIn: 2.0 }] });
  assert.match(body, /1 covering storm, 1 at 1"\+/);
  assert.doesNotMatch(body, /1 covering storms/);
});

test("lead sms: no storms on record", () => {
  const body = buildLeadSmsBody({ name: "Sam", storms: [] });
  assert.match(body, /no verified covering storms on record/);
  assert.match(body, /Sam/);
});

test("lead sms: missing fields fall back to safe defaults", () => {
  const body = buildLeadSmsBody({});
  assert.match(body, /Homeowner/);
  assert.match(body, /Oklahoma home/);
  assert.match(body, /no verified covering storms/);
});

test("lead sms: long address truncates, body capped", () => {
  const body = buildLeadSmsBody({
    name: "A".repeat(100),
    address: "B".repeat(300),
    rec: { headline: "C".repeat(300) },
    storms: [{ date: "2025-10-23", maxSizeIn: 3 }],
  });
  assert.ok(body.length <= 480, `body too long: ${body.length}`);
});
