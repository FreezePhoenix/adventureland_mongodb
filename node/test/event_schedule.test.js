"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { create_schedule, HOUR, DAY } = require("../logic/event_schedule");
const { read, extract } = require("./helpers/server_vm");

// 2026-10-20 10:00 UTC is 11:00 on the EU realm clock (offset +1).
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const END = Date.UTC(2026, 10, 3, 0, 0, 0);
const at_realm = (day, hour, minute = 0) => Date.UTC(2026, 9, day, hour - 1, minute);

function make(saved, now, open = { halloween: true }) {
	return create_schedule({
		saved,
		offset: 1,
		pools: { dailies: ["crabxx", "goobrawl", "abtesting"], nightlies: ["icegolem", "franky"] },
		realm: "EUI",
		season_open: (season, when) => !!open[season] && when < END,
		now: () => now,
	});
}

test("publishes seven days on the realm clock and rotates the daily and nightly queues", () => {
	const schedule = make(undefined, T0);
	schedule.tick(T0);
	const { events, repeats, realm } = schedule.publish(T0);
	assert.equal(realm, "EUI");
	const first = events
		.filter((o) => o.at >= T0)
		.slice(0, 6)
		.map((o) => [o.event, new Date(o.at).toISOString()]);
	assert.deepEqual(first, [
		["crabxx", "2026-10-20T12:00:00.000Z"],
		["witchcipher", "2026-10-20T17:00:00.000Z"],
		["goobrawl", "2026-10-20T19:00:00.000Z"],
		["icegolem", "2026-10-20T22:00:00.000Z"],
		["horseman", "2026-10-20T23:00:00.000Z"],
		["abtesting", "2026-10-21T12:00:00.000Z"],
	]);
	assert(events.every((o) => o.at <= T0 + 7 * DAY));
	assert.equal(events.filter((o) => o.event === "witchcipher").length, 7);
	// Graveyard Rising is one line with its cadence, not twelve rows a day.
	assert.equal(
		events.some((o) => o.event === "graveyard"),
		false,
	);
	assert.deepEqual(
		repeats.map((r) => [r.event, new Date(r.at).toISOString(), r.every]),
		[["graveyard", "2026-10-20T10:30:00.000Z", 2 * HOUR]],
	);
});

test("a restart keeps the published lineup and the queue order", () => {
	const first = make(undefined, T0);
	first.tick(T0);
	const saved = JSON.parse(JSON.stringify(first.state()));
	const before = first.publish(T0).events.map((o) => o.id);
	const again = make(saved, T0 + 5 * 60000);
	again.tick(T0 + 5 * 60000);
	assert.deepEqual(
		again.publish(T0 + 5 * 60000).events.map((o) => o.id),
		before,
	);
});

test("an occurrence starts once, late inside its hour, and is missed after it", () => {
	const schedule = make(undefined, T0);
	schedule.tick(T0);
	const daily = at_realm(20, 13);
	assert.deepEqual(
		schedule.tick(daily - 1000).map((o) => o.event),
		[],
	);
	// The startup grace holds it back without losing it.
	assert.deepEqual(
		schedule.tick(daily + 60000, { can_start: false }).map((o) => o.event),
		[],
	);
	const started = schedule.tick(daily + 20 * 60000);
	assert.deepEqual(
		started.map((o) => o.event),
		["crabxx"],
	);
	// A restart after the start must not run it again.
	const saved = JSON.parse(JSON.stringify(schedule.state()));
	const restarted = make(saved, daily + 25 * 60000);
	assert.deepEqual(
		restarted.tick(daily + 25 * 60000).map((o) => o.event),
		[],
	);
	restarted.finish("crabxx", daily + 30 * 60000);
	assert.equal(
		restarted.publish(daily + 30 * 60000).events.find((o) => o.event === "crabxx" && o.at === daily).status,
		"done",
	);
	// The 18:00 Witch's Cipher is missed when nothing ticks during its hour.
	restarted.tick(at_realm(20, 19, 5));
	assert.equal(restarted.publish(at_realm(20, 19, 5)).events.find((o) => o.event === "witchcipher").status, "missed");
});

test("seasonal occurrences stop at the season's end and when it closes", () => {
	const schedule = make(undefined, Date.UTC(2026, 9, 30, 10));
	schedule.tick(Date.UTC(2026, 9, 30, 10));
	const horseman = schedule.publish(Date.UTC(2026, 9, 30, 10)).events.filter((o) => o.event === "horseman");
	assert(horseman.length > 0);
	assert(horseman.every((o) => o.at < END));
	const open = { halloween: true };
	const closing = create_schedule({
		saved: JSON.parse(JSON.stringify(schedule.state())),
		offset: 1,
		pools: { dailies: ["crabxx", "goobrawl", "abtesting"], nightlies: ["icegolem", "franky"] },
		realm: "EUI",
		season_open: (season, when) => !!open[season] && when < END,
		now: () => Date.UTC(2026, 9, 30, 11),
	});
	open.halloween = false;
	closing.tick(Date.UTC(2026, 9, 30, 11));
	const published = closing.publish(Date.UTC(2026, 9, 30, 11));
	assert.equal(published.events.filter((o) => o.event === "horseman" && o.status === "scheduled").length, 0);
	assert.equal(published.repeats.length, 0);
	assert(
		published.events.some((o) => o.event === "witchcipher"),
		"the Witch's Cipher runs all year",
	);
});

test("a new pool member joins the end of the saved queue and a removed one leaves", () => {
	const schedule = make(undefined, T0);
	schedule.tick(T0);
	const saved = JSON.parse(JSON.stringify(schedule.state()));
	const changed = create_schedule({
		saved,
		offset: 1,
		pools: { dailies: ["crabxx", "goobrawl", "newevent"], nightlies: ["icegolem", "franky"] },
		realm: "EUI",
		season_open: () => true,
		now: () => T0,
	});
	assert.deepEqual(changed.state().queues.dailies.slice().sort(), ["crabxx", "goobrawl", "newevent"]);
	assert.equal(changed.state().queues.dailies[2], "newevent");
});

test("an occurrence saved as starting counts as missed after a restart", () => {
	const schedule = make(undefined, T0);
	schedule.tick(T0);
	const daily = at_realm(20, 13);
	const [started] = schedule.tick(daily + 60000);
	started.starting = true; // the lineup was saved, then the server stopped before the start
	const restarted = make(JSON.parse(JSON.stringify(schedule.state())), daily + 5 * 60000);
	assert.deepEqual(
		restarted.tick(daily + 5 * 60000).map((o) => o.event),
		[],
	);
	const entry = restarted.publish(daily + 5 * 60000).events.find((o) => o.event === "crabxx" && o.at === daily);
	assert.equal(entry.status, "missed");
});

test("the server saves the lineup before it starts an occurrence", async () => {
	let release;
	const saves = [];
	const c = vm.createContext({
		event_schedule: null,
		event_schedule_rules: require("../logic/event_schedule"),
		S: {},
		E: { schedule: { time_offset: 1 } },
		dailies: ["crabxx", "goobrawl"],
		nightlies: ["icegolem"],
		region: "EU",
		server_name: "I",
		events: {},
		event_ends: {},
		server: { live: true },
		server_start: new Date(0),
		msince: () => 10,
		Server: { updated: new Date() },
		save() {
			saves.push(JSON.parse(JSON.stringify(c.S.schedule)));
			return new Promise((resolve, reject) => (release = (ok) => (ok ? resolve() : reject(new Error("save failed")))));
		},
		witch_cipher_start() {},
		graveyard_start() {},
		broadcast_e() {},
		log_trace() {},
	});
	const source = read("node/server_functions.js");
	vm.runInContext(["event_schedule_state", "event_schedule_tick"].map((name) => extract(source, name)).join("\n"), c);
	c.event_schedule_tick(T0);
	assert.equal(saves.length, 0, "nothing due yet");
	const daily = at_realm(20, 13);
	c.event_schedule_tick(daily + 60000);
	assert.equal(saves.length, 1);
	const saved = saves[0].occurrences.find((o) => o.event === "crabxx" && o.at === daily);
	assert.deepEqual([saved.status, saved.starting], ["live", true], "saved as starting");
	assert.equal(c.events.crabxx, undefined, "not started before the save");
	c.event_schedule_tick(daily + 2 * 60000);
	assert.equal(c.S.schedule.occurrences.find((o) => o.event === "crabxx").status, "live", "not finished either");
	release(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(c.events.crabxx, true);
	assert.equal(c.S.schedule.occurrences.find((o) => o.event === "crabxx").starting, undefined);
	assert.equal(c.Server.updated.getTime(), 0, "the started round is saved on the next loop");
	c.event_schedule_tick(daily + 3 * 60000);
	assert.equal(saves.length, 1, "it starts once");
	// A failed save starts nothing; the next tick tries again.
	const evening = at_realm(20, 20);
	c.event_schedule_tick(evening + 60000);
	assert.equal(saves.length, 2);
	release(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(c.events.goobrawl, undefined);
	assert.equal(c.S.schedule.occurrences.find((o) => o.at === evening).status, "scheduled");
	c.event_schedule_tick(evening + 2 * 60000);
	assert.equal(saves.length, 3, "tried again");
	// The server began stopping while the save ran: the occurrence is missed, not started.
	c.server.live = false;
	release(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(c.events.goobrawl, undefined);
	assert.equal(c.S.schedule.occurrences.find((o) => o.at === evening).status, "missed");
});
