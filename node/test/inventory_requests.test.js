"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const G = require("./helpers/design");
const { read, load, socketHandler } = require("./helpers/server_vm");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
	const failures = [],
		successes = [],
		effects = [];
	G.maps.main.upgrade ||= { map: "main", in: "main", x: -204, y: -129 };
	const make = (name) => ({
		id: name,
		name,
		owner: name,
		map: "main",
		in: "main",
		x: 0,
		y: 0,
		str: 10,
		items: Array(42).fill(null),
		citems: [],
		isize: 42,
		esize: 42,
		s: {},
		q: {},
		p: { stats: { exchanges: {} } },
		computer: true,
		socket: { id: name, emit() {} },
		gold: 1000,
	});
	const player = make("Sender"),
		receiver = make("Receiver");
	const c = vm.createContext({
		...G,
		G,
		D: G,
		players: { Sender: player, Receiver: receiver },
		name_to_id: { Sender: "Sender", Receiver: "Receiver" },
		socket: player.socket,
		min: Math.min,
		max: Math.max,
		round: Math.round,
		gameplay: "normal",
		Dev: false,
		B: { dist: 500, sell_dist: 500 },
		a_score: {},
		instances: { main: { monsters: {} } },
		future_s: (s) => new Date(Date.now() + s * 1000),
		fail_response: (reason, data) => failures.push({ reason, data }),
		success_response: (...args) => successes.push(args),
		xy_emit: (...args) => effects.push(args),
		add_to_history() {},
		resend() {},
		server_log(message) {
			if (String(message).startsWith("upgrade_e")) throw Error(message);
		},
		randomStr: () => "test-instance",
		can_walk: () => true,
	});
	const source = read("node/server_functions.js");
	vm.runInContext(source.match(/var item_p_ignore = \{[\s\S]*?\};/)[0], c);
	load(c, "node/server_functions.js", ["cache_item", "is_same", "seen_item_matches"]);
	load(c, "js/old_common_functions.js", ["can_stack", "can_add_item", "can_add_items", "distance", "simple_distance"]);
	load(c, "node/server.js", [
		"create_new_item",
		"create_new_sitem",
		"consume",
		"consume_one",
		"consume_one_by_id",
		"add_item",
	]);
	function put(who, item, size = 42) {
		who.items = Array.from({ length: size }, () => ({ name: "blade", level: 0 }));
		who.items[0] = plain(item);
		who.esize = 42 - size;
	}
	function run(event, data) {
		return socketHandler(c, event)(plain(data));
	}
	return { c, player, receiver, put, run, failures, successes, effects };
}

test("a queued sale cannot sell a replacement item; current and legacy sales still work", () => {
	for (const actual of [
		{ name: "firestars", level: 7 },
		{ name: "blade", level: 7 },
		{ name: "blade", level: 0, p: "shiny" },
	]) {
		const h = fixture();
		h.player.items[0] = actual;
		h.run("sell", { num: 0, quantity: 1, item: { name: "blade", level: 0 } });
		assert.equal(h.failures[0].reason, "item_changed");
		assert.deepEqual(h.player.items[0], actual);
		assert.equal(h.player.gold, 1000);
	}
	for (const seen of [undefined, { name: "hpot0", q: 10 }]) {
		const h = fixture();
		h.c.G.maps.main.merchants = [{ x: 0, y: 0 }];
		h.c.calculate_item_value = () => 10;
		h.c.secondhands_logic = () => {};
		h.player.items[0] = { name: "hpot0", q: 8 };
		h.run("sell", { num: 0, quantity: 2, item: seen });
		assert.equal(h.failures.length, 0);
		assert.equal(h.player.items[0].q, 6);
		assert.equal(h.player.gold, 1020);
	}
});

test("throw rejects distant or non-finite coordinates without consuming items or sending effects", () => {
	for (const target of [
		{ x: 31, y: 0 },
		{ x: "Infinity", y: 0 },
		{ x: "NaN", y: 0 },
	]) {
		const h = fixture();
		h.player.items[0] = { name: "confetti", q: 2 };
		h.run("throw", { num: 0, ...target });
		assert.equal(h.failures.length, 1);
		assert.equal(h.successes.length, 0);
		assert.equal(h.effects.length, 0);
		assert.equal(h.player.items[0].q, 2);
	}
	const h = fixture();
	h.player.items[0] = { name: "confetti", q: 2 };
	h.run("throw", { num: 0, x: "30", y: 0 });
	assert.equal(h.failures.length, 0);
	assert.equal(h.successes.length, 1);
	assert.equal(h.effects.length, 1);
	assert.equal(h.player.items[0].q, 1);
});

test("split reserves a real empty inventory slot before consuming a stack", () => {
	for (const size of [42, 43]) {
		const h = fixture();
		h.put(h.player, { name: "hpot0", q: 10 }, size);
		const before = plain(h.player.items);
		h.run("split", { num: 0, quantity: 3 });
		assert.deepEqual(
			h.failures.map((r) => r.reason),
			["cant_space"],
		);
		assert.deepEqual(plain(h.player.items), before);
		assert.equal(h.successes.length, 0);
	}
	const h = fixture();
	h.player.items[0] = { name: "hpot0", q: 10, p: "glitched", ps: ["glitched"] };
	h.run("split", { num: 0, quantity: 3 });
	assert.equal(h.player.items[0].q, 7);
	assert.equal(h.player.items[1].q, 3);
	assert.equal(h.player.items[1].p, "glitched");
	assert.equal(h.successes[0][0].to, 1);
});

test("an exchange may use its own emptied slot but cannot overflow an inventory", () => {
	const name = "seashell",
		required = G.items[name].e;
	assert(required > 1 && G.drops[name]);
	for (const quantity of [required, required + 1]) {
		const h = fixture();
		h.put(h.player, { name, q: quantity });
		h.run("exchange", { item_num: 0 });
		if (quantity === required) {
			assert.equal(h.failures.length, 0);
			assert.equal(h.player.items[0].name, "placeholder");
			assert.equal(h.player.q.exchange.q, required);
			assert.equal(h.player.items.length, 42);
		} else {
			assert.deepEqual(
				h.failures.map((r) => r.reason),
				["inventory_full"],
			);
			assert.equal(h.player.items[0].q, quantity);
		}
	}
});

test("malformed inventory slots never fall back to slot zero", () => {
	for (const slot of [-1, 0.5, "0junk", "", null, false, [], {}, "Infinity"])
		for (const event of ["destroy", "send", "imove"]) {
			const h = fixture();
			h.player.items[0] = { name: "hpot0", q: 2 };
			const before = plain(h.player.items);
			h.run(event, { num: slot, a: slot, b: 1, name: "Receiver", q: 1 });
			assert.deepEqual(plain(h.player.items), before, event + " " + JSON.stringify(slot));
			assert.equal(h.failures.length, 1);
		}
	for (const slot of [0, "0"]) {
		const h = fixture();
		h.player.items[0] = { name: "hpot0", q: 2 };
		h.run("destroy", { num: slot, q: 1 });
		assert.equal(h.player.items[0].q, 1);
		assert.equal(h.failures.length, 0);
	}
});

test("sending checks capacity with the exact item properties", () => {
	for (const same of [false, true]) {
		const h = fixture();
		const item = { name: "cxjar", q: 2, data: "hat001" };
		h.player.items[0] = plain(item);
		h.put(h.receiver, { name: "cxjar", q: 1, data: same ? "hat001" : "hat002" });
		h.run("send", { num: 0, q: 1, name: "Receiver" });
		assert.equal(h.player.items[0].q, same ? 1 : 2);
		assert.equal(h.receiver.items[0].q, same ? 2 : 1);
		assert.equal(h.receiver.items.length, 42);
		assert.equal(h.failures.length, same ? 0 : 1);
	}
});

test("batch capacity allocates each reward once and accounts for newly created stacks", () => {
	const h = fixture();
	h.put(h.player, { name: "hpot0", q: 1 });
	h.player.items[1] = { name: "hpot0", q: 1 };
	assert.equal(
		h.c.can_add_items(h.player, [
			{ name: "hpot0", q: 1 },
			{ name: "blade", level: 0 },
		]),
		false,
	);
	h.player.items[0] = null;
	h.player.items[1] = { name: "blade", level: 0 };
	h.player.esize = 1;
	const rewards = [
		{ name: "hpot0", q: 2 },
		{ name: "hpot0", q: 3 },
	];
	assert.equal(h.c.can_add_items(h.player, rewards), true);
	for (const item of rewards) h.c.add_item(h.player, item, { announce: false });
	assert.equal(h.player.items[0].q, 5);
	assert.equal(h.player.items.length, 42);
});

test("a chest stays available when matching potion stacks leave no room for its equipment", () => {
	const h = fixture();
	h.put(h.player, { name: "hpot0", q: 1 });
	h.player.items[1] = { name: "hpot0", q: 1 };
	const chest = {
		items: [
			{ name: "hpot0", q: 1 },
			{ name: "blade", level: 0 },
		],
		x: 0,
		y: 0,
		date: new Date(),
		gold: 0,
	};
	Object.assign(h.c, { chests: { reward: chest }, msince: () => 0, is_invis: () => false });
	const before = plain(h.player.items);
	h.run("open_chest", { id: "reward" });
	assert.deepEqual(
		h.failures.map((r) => r.reason),
		["loot_no_space"],
	);
	assert.equal(h.c.chests.reward, chest);
	assert.deepEqual(plain(h.player.items), before);
});

test("entry errors identify each required key without consuming anything", () => {
	for (const [place, map, spawn, key] of [
		["crypt", "cave", 2, "cryptkey"],
		["winter_instance", "winterland", 5, "frozenkey"],
		["spider_instance", "gateway", 3, "spiderkey"],
		["tomb", "mansion", 1, "tombkey"],
	]) {
		const h = fixture();
		Object.assign(h.player, { map, in: map, x: G.maps[map].spawns[spawn][0], y: G.maps[map].spawns[spawn][1] });
		h.run("enter", { place });
		assert.deepEqual(plain(h.failures), [{ reason: "transport_cant_item", data: { items: { [key]: 1 } } }]);
		assert(h.player.items.every((item) => !item));
	}
});

test("Primling preview identifies grace without consuming; applying it retains level", () => {
	const h = fixture();
	h.player.items[0] = { name: "coat", level: 0, grace: 2 };
	h.player.items[1] = { name: "offeringp", q: 2 };
	h.run("upgrade", { item_num: 0, offering_num: 1, scroll_num: null, clevel: 0, calculate: true });
	assert.equal(h.successes[0][0], "upgrade_chance");
	assert.equal(h.successes[0][1].grace_added, 0.5);
	assert.equal(h.player.items[0].grace, 2);
	assert.equal(h.player.items[1].q, 2);
	h.run("upgrade", { item_num: 0, offering_num: 1, scroll_num: null, clevel: 0 });
	assert.equal(h.player.p.u_item.grace, 2.5);
	assert.equal(h.player.p.u_item.level, 0);
	assert.equal(h.player.items[1].q, 1);
	assert.equal(h.player.items[0].p.grace_added, 0.5);
});

test("unsupported upgrade and compound levels preserve items, scrolls and offerings", () => {
	for (const [event, name, level, scroll] of [
		["upgrade", "luckyt", 0, "scroll3"],
		["compound", "gloampendant", 6, "cscroll3"],
		["compound", "coal", 10, "cscroll3"],
	]) {
		for (const calculate of [false, true]) {
			const h = fixture();
			const responses = [];
			h.player.socket.emit = (event, data) => responses.push(data);
			h.c.server_log = () => {};
			G.maps.main.compound ||= { map: "main", in: "main", x: 0, y: 0 };
			G.items[name].igrade = G.calculate_item_grade(G.items[name]);
			h.player.items[0] = { name, level, grace: 2 };
			if (event === "compound") {
				h.player.items[1] = { name, level, grace: 3 };
				h.player.items[2] = { name, level, grace: 4 };
			}
			h.player.items[3] = { name: scroll, q: 2 };
			h.player.items[4] = { name: "offering", q: 2 };
			const before = plain(h.player);
			h.run(event, { item_num: 0, items: [0, 1, 2], clevel: level, scroll_num: 3, offering_num: 4, calculate });
			assert.deepEqual(responses, [event + "_cant"]);
			assert.deepEqual(plain(h.player), before);
		}
	}
});

test("supported upgrade and compound previews still use the existing chances", () => {
	for (const [event, name, scroll] of [
		["upgrade", "coat", "scroll0"],
		["compound", "strring", "cscroll0"],
	]) {
		const h = fixture();
		G.maps.main.compound ||= { map: "main", in: "main", x: 0, y: 0 };
		G.items[name].igrade = G.calculate_item_grade(G.items[name]);
		G.items[name].igrace = 1;
		h.player.p.ograce = 0;
		h.player.p.ugrace = Array(20).fill(0);
		h.c.S = { u: 0, ugrace: Array(20).fill(0) };
		h.player.items[0] = { name, level: 0 };
		h.player.items[1] = { name, level: 0 };
		h.player.items[2] = { name, level: 0 };
		h.player.items[3] = { name: scroll, q: 2 };
		const before = plain(h.player.items);
		h.run(event, { item_num: 0, items: [0, 1, 2], clevel: 0, scroll_num: 3, calculate: true });
		assert.equal(h.successes[0][0], event + "_chance");
		assert(Number.isFinite(h.successes[0][1].chance));
		assert(h.successes[0][1].chance > 0 && h.successes[0][1].chance <= 1);
		assert.deepEqual(plain(h.player.items), before);
	}
});

test("Glitch exchanges award both unstackable copies, directly and inside chests", () => {
	for (const chest of [false, true]) {
		const h = fixture();
		Object.assign(h.c, {
			Math: Object.assign(Object.create(Math), { random: () => 0.999999 }),
			character_slots: [],
			colors: { server_success: "green" },
			item_to_phrase: (item) => item.name,
			broadcast() {},
			to_pretty_num: String,
		});
		load(h.c, "node/server_functions.js", ["exchange", "chest_exchange", "add_item_property"]);
		assert.deepEqual(plain(G.drops.glitch.at(-1)), [5, "glitch", 2]);
		const target = chest ? { gold: 0, cash: 0, items: [] } : h.player;
		if (chest) h.c.chest_exchange(target, "glitch");
		else h.c.exchange(target, "glitch");
		const items = target.items.filter((item) => item && item.name === "glitch");
		assert.equal(items.length, 2);
		assert.notEqual(items[0], items[1]);
		assert(items.every((item) => !item.q));
	}
});

test("compounded dismantling respects locked and sealed items before charging gold", () => {
	for (const protection of [{ l: "l" }, { l: "s" }, { l: "u" }, { b: true }, {}]) {
		const h = fixture();
		h.c.calculate_item_value = () => 10;
		h.player.items[0] = { name: "strring", level: 2, ...protection };
		const before = plain(h.player.items);
		h.run("dismantle", { num: 0 });
		if (protection.l || protection.b) {
			assert.equal(h.failures[0].reason, protection.l ? "item_locked" : "item_blocked");
			assert.deepEqual(plain(h.player.items), before);
			assert.equal(h.player.gold, 1000);
		} else {
			assert.equal(h.failures.length, 0);
			assert.equal(h.player.items.filter((item) => item?.name === "strring" && item.level === 1).length, 3);
			assert.equal(h.player.gold, 900);
		}
	}
});

test("merchant luck bonuses keep the original loot recipient's inventory slot", () => {
	const h = fixture();
	h.player.items[0] = { name: "blade", level: 0 };
	h.player.s.mluck = { f: h.receiver.name };
	h.c.get_player = () => h.receiver;
	h.c.Math = Object.assign(Object.create(Math), { random: () => 0.01 });
	h.c.colors = {};
	const slot = h.c.add_item(h.player, { name: "hpot0", q: 1 }, { m: true });
	assert.equal(slot, 1);
	assert.equal(h.player.items[slot].name, "hpot0");
	assert.equal(h.receiver.items[0].name, "hpot0");
	const event = h.effects.find(([, event, data]) => event === "ui" && data.type === "+M");
	assert.equal(event[2].num, 0);
});

test("nested chest exchanges retain the same Lucky property as direct envelopes", () => {
	for (const name of ["greenenvelope", "brownenvelope"]) {
		const h = fixture();
		load(h.c, "node/server_functions.js", ["chest_exchange", "add_item_property"]);
		const row = G.drops[name].findIndex((drop) => drop[4] === "lucky");
		const roll =
			(G.drops[name].slice(0, row).reduce((sum, drop) => sum + drop[0], 0) + G.drops[name][row][0] / 2) /
			G.drops[name].reduce((sum, drop) => sum + drop[0], 0);
		h.c.Math = Object.assign(Object.create(Math), { random: () => roll });
		const chest = { gold: 0, cash: 0, items: [] };
		h.c.chest_exchange(chest, [[1, "open", name]]);
		assert.equal(chest.items[0].name, G.drops[name][row][1]);
		assert.equal(chest.items[0].p, G.drops[name][row][4]);
		assert.deepEqual(plain(chest.items[0].ps), ["lucky"]);
	}
});
