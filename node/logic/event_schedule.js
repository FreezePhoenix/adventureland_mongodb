"use strict";

// The published event lineup: seven days of named occurrences on the realm clock. The lineup and
// the rotation queues live in the server's saved data, so a restart neither reshuffles what players
// were shown nor starts an occurrence twice. Times are UTC milliseconds; the client shows them in
// the player's time or on the realm clock.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const VERSION = 1;

// Late starts are allowed inside the slot's hour (a restart at 13:20 still runs the 13:00 event),
// never later; a short repeating event allows less. Finished and missed ones stay visible a while.
const LATE = HOUR;
const KEEP = 6 * HOUR;

// hours/minute are on the realm clock. pool: a rotation queue; event: a fixed event.
// season: only while that season runs (and before its end). repeat: frequent, shown as one line.
const SLOTS = [
	{ hours: [13, 20], pool: "dailies" },
	{ hours: [23], pool: "nightlies" },
	{ hours: [18], event: "witchcipher" },
	{ hours: [0], event: "horseman", season: "halloween" },
	{
		hours: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23],
		minute: 30,
		event: "graveyard",
		season: "halloween",
		repeat: true,
		late: 10 * 60000,
	},
];

function create_schedule({ saved, offset, pools, realm, season_open, now = Date.now, days = 7, slots = SLOTS }) {
	let state = saved;
	function fresh() {
		const queues = {};
		for (const name in pools) queues[name] = pools[name].slice();
		return { version: VERSION, offset, queues, until: null, occurrences: [] };
	}
	if (!state || state.version !== VERSION || state.offset !== offset || !Array.isArray(state.occurrences))
		state = fresh();
	// The lineup is saved before an occurrence starts. One still marked as starting was cut off by a
	// restart before its own state was saved, so it counts as missed rather than running twice.
	for (const o of state.occurrences)
		if (o.starting) {
			delete o.starting;
			o.status = "missed";
			o.ended = o.started || o.at;
		}
	// Keep the saved order for known events, add new pool members at the end and drop removed ones.
	for (const name in pools) {
		const kept = (state.queues[name] || []).filter((event) => pools[name].includes(event));
		state.queues[name] = kept.concat(pools[name].filter((event) => !kept.includes(event)));
	}

	function realm_day_start(at) {
		const shifted = at + offset * HOUR;
		return shifted - (((shifted % DAY) + DAY) % DAY) - offset * HOUR;
	}
	function slot_id(event, at) {
		const d = new Date(at + offset * HOUR);
		const pad = (n) => String(n).padStart(2, "0");
		return (
			realm +
			"-" +
			d.getUTCFullYear() +
			"-" +
			pad(d.getUTCMonth() + 1) +
			"-" +
			pad(d.getUTCDate()) +
			"-" +
			pad(d.getUTCHours()) +
			pad(d.getUTCMinutes()) +
			"-" +
			event
		);
	}
	// Every slot start in (from, to], in time order.
	function starts_between(from, to) {
		const list = [];
		for (let day = realm_day_start(from); day <= to; day += DAY)
			for (const slot of slots)
				for (const hour of slot.hours) {
					const at = day + hour * HOUR + (slot.minute || 0) * 60000;
					if (at > from && at <= to) list.push({ at, slot });
				}
		return list.sort((a, b) => a.at - b.at);
	}
	function extend(t) {
		const horizon = t + days * DAY;
		// A new lineup starts with the slot in progress, so a restart inside a slot hour still runs it.
		const from = state.until === null ? t - LATE : state.until;
		for (const { at, slot } of starts_between(from, horizon)) {
			if (slot.season && !season_open(slot.season, at)) continue;
			let event = slot.event;
			if (slot.pool) {
				const queue = state.queues[slot.pool];
				if (!queue || !queue.length) continue;
				event = queue.shift();
				queue.push(event);
			}
			const occurrence = { id: slot_id(event, at), event, at, status: "scheduled" };
			if (slot.season) occurrence.season = slot.season;
			if (slot.repeat) occurrence.repeat = true;
			if (slot.late) occurrence.late = slot.late;
			state.occurrences.push(occurrence);
		}
		state.until = Math.max(from, horizon);
	}
	function prune(t) {
		state.occurrences = state.occurrences.filter((o) => {
			// A season that closed takes its future occurrences with it.
			if (o.season && o.status === "scheduled" && !season_open(o.season, o.at)) return false;
			if (o.status === "scheduled" || o.status === "live") return true;
			return t - (o.ended || o.at) < KEEP;
		});
	}

	return {
		state: () => state,
		// Occurrences that should start now. The caller starts each one; it is marked live first.
		tick(t = now(), { can_start = true } = {}) {
			extend(t);
			prune(t);
			const due = [];
			for (const o of state.occurrences) {
				if (o.status !== "scheduled" || o.at > t) continue;
				if (t - o.at >= (o.late || LATE)) {
					o.status = "missed";
					o.ended = o.at + (o.late || LATE);
				} else if (can_start) {
					o.status = "live";
					o.started = t;
					due.push(o);
				}
			}
			prune(t);
			return due;
		},
		// The live occurrence of an event has ended (finished, defeated or interrupted).
		finish(event, t = now(), outcome = "done") {
			for (const o of state.occurrences)
				if (o.event === event && o.status === "live") {
					o.status = outcome;
					o.ended = t;
				}
		},
		next(event, t = now()) {
			return state.occurrences.find((o) => o.event === event && o.at > t && o.status === "scheduled") || null;
		},
		// The public lineup for server.status.schedule: dated occurrences, plus one line per repeat.
		publish(t = now()) {
			const events = [],
				repeats = {};
			for (const o of state.occurrences) {
				const entry = { id: o.id, event: o.event, at: o.at, status: o.status };
				if (o.season) entry.season = o.season;
				if (o.started) entry.started = o.started;
				if (o.ended) entry.ended = o.ended;
				if (!o.repeat) events.push(entry);
				else if (
					o.status === "live" ||
					(o.status === "scheduled" && (!repeats[o.event] || repeats[o.event].status !== "live"))
				) {
					if (!repeats[o.event] || o.status === "live" || o.at < repeats[o.event].at) repeats[o.event] = entry;
				}
			}
			const every = {};
			for (const slot of slots) if (slot.repeat) every[slot.event] = DAY / slot.hours.length;
			return {
				realm,
				server_time: t,
				events: events.sort((a, b) => a.at - b.at),
				repeats: Object.values(repeats).map((entry) => Object.assign(entry, { every: every[entry.event] })),
			};
		},
	};
}

module.exports = { create_schedule, SLOTS, HOUR, DAY };
