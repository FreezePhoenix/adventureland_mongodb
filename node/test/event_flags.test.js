"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { read, extract, load, socketHandler } = require("./helpers/server_vm");
const root = path.resolve(__dirname, "../..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const main = read("main.js");
const server = read("node/server.js");

function context(flags = {}, gameplay = "normal") {
	const fetched = [];
	const c = vm.createContext({
		console: { log() {} },
		path,
		fs: {
			readFileSync(filename) {
				let source = fs.readFileSync(filename, "utf8");
				if (filename.endsWith("design/event_flags.js"))
					source += "\nObject.assign(event_flags," + JSON.stringify(flags) + ");";
				return source;
			},
		},
		__dirname: root,
		Version: 1,
		docs: {},
		gameplay,
		get(key) {
			fetched.push(key);
			return { info: { data: { x_lines: [], y_lines: [], placements: [], key } } };
		},
	});
	vm.runInContext(read("common/js/common_functions.js"), c);
	return { c, fetched };
}

async function browser(flags) {
	const h = context(flags);
	vm.runInContext(main.slice(main.indexOf("// /design"), main.indexOf("// docs")), h.c);
	vm.runInContext(extract(main, "get_browser_data"), h.c);
	h.c.G = await h.c.get_browser_data();
	vm.runInContext(read("js/old_common_functions.js"), h.c);
	h.c.process_game_data();
	return h;
}

test("Christmas selects geometry, NPCs and quests before loading data, then restores the ordinary world", async () => {
	for (const active of [false, true, false]) {
		const { c, fetched } = await browser({ holidayseason: active });
		const G = c.G;
		assert.equal(G.maps.main.key, active ? "jayson_ALMap2_v2_xmas" : "jayson_ALMap2_v2");
		assert.equal(G.maps.bank.key, active ? "jayson_bank0.Xmas" : "jayson_bank0");
		assert(fetched.includes("MP_" + G.maps.main.key));
		assert(fetched.includes("MP_" + G.maps.bank.key));
		assert.equal(G.maps.main.geometry, undefined);
		assert.equal(G.geometry.main.key, "MP_" + G.maps.main.key);
		for (const [map, id] of [
			["main", "newyear_tree"],
			["winter_inn", "mistletoe"],
			["winterland", "santa"],
			["winterland", "ornaments"],
		])
			assert.equal(G.maps[map].npcs.filter((npc) => npc.id === id).length, Number(active));
		assert.equal(G.maps.winterland.monsters.filter((monster) => monster.type === "rudolph").length, Number(active));
		for (const id of ["mistletoe", "candycane", "ornament"]) {
			assert.equal(G.items[id].quest, active ? id : undefined);
			assert.equal(!!G.quests[id], active);
			assert(G.drops[id].length, "saved materials keep their exchange rewards");
			assert.equal(G.drops.maps.global.filter((row) => row[1] === id).length, Number(active));
		}
		assert(G.maps.main.ref.exchange);
		assert(G.maps.main.ref.craftsman);
		assert.equal(c.crafting_npc(G.craft.sixcake, G.event_flags), "craftsman");
	}
});

test("each seasonal switch keeps its own drops, maps and respawns", async () => {
	const defaults = (await browser()).c.G.event_flags;
	assert.deepEqual(plain(defaults), {
		anniversary: false,
		holidayseason: false,
		lunarnewyear: false,
		valentines: false,
		egghunt: false,
		halloween: true,
	});
	const off = Object.fromEntries(Object.keys(defaults).map((name) => [name, false]));
	for (const [name, reward] of Object.entries({
		anniversary: "anniversarygift",
		holidayseason: "ornament",
		lunarnewyear: "brownenvelope",
		valentines: "candypop",
		egghunt: "goldenegg",
		halloween: "candy0",
	})) {
		const { c } = await browser({ ...off, [name]: true });
		assert.equal(c.G.drops.maps.global.filter((row) => row[1] === reward).length, 1);
		assert.equal(
			c.G.maps.main.key,
			name === "holidayseason"
				? "jayson_ALMap2_v2_xmas"
				: name === "lunarnewyear"
					? "jayson_ALMap2_v2.lunarNewYear"
					: "jayson_ALMap2_v2",
		);
		assert.equal(
			c.crafting_npc(c.G.craft.sixcake, c.G.event_flags),
			name === "anniversary" ? "anniversary_baker" : "craftsman",
		);
		if (name === "halloween") assert.equal(c.G.monsters.jr.respawn, 480);
	}
	assert.equal((await browser(off)).c.G.drops.maps.global.length, 0);
	await assert.rejects(browser({ holidayseason: true, lunarnewyear: true }), /Conflicting event maps/);
	await assert.rejects(browser({ holidayseason: true, anniversary: true }), /Conflicting seasonal NPCs/);
	await assert.rejects(browser({ holidayseason: "false" }), /must be boolean/);
});

test("server startup and reload resolve seasons before their actual geometry fetches", async () => {
	const start = server.indexOf("// Load all design files");
	const end = server.indexOf('server_log("Game Version:', start);
	for (const active of [false, true]) {
		const h = context({ holidayseason: active });
		h.c.__dirname = path.join(root, "node");
		await vm.runInContext("(async function(){" + server.slice(start, end) + "})()", h.c);
		assert.equal(h.c.G.event_flags.holidayseason, active);
		assert.equal(h.c.G.geometry.main.key, "MP_" + h.c.G.maps.main.key);
		const reloadStart = server.indexOf("// Re-eval all design files");
		const reloadEnd = server.indexOf("\n\t\tD = {", reloadStart);
		await vm.runInContext("(async function(){" + server.slice(reloadStart, reloadEnd) + "})()", h.c);
		assert.equal(h.c.G.event_flags.holidayseason, active);
		h.c.G.event_flags.holidayseason = !active;
		await assert.rejects(
			vm.runInContext("(async function(){" + server.slice(reloadStart, reloadEnd) + "})()", h.c),
			/restart the game server/,
		);
	}
});

test("the real exchange handler accepts Christmas ingredients at seasonal NPCs or Xyn", async () => {
	for (const active of [false, true]) {
		const { c } = await browser({ holidayseason: active });
		c.D = { drops: c.G.drops };
		c.B = { sell_dist: 400 };
		c.a_score = {};
		c.resend = () => {};
		vm.runInContext(read("node/server_functions.js").match(/var item_p_ignore = \{[\s\S]*?\};/)[0], c);
		load(c, "node/server_functions.js", ["cache_item"]);
		load(c, "node/server.js", ["consume", "add_item", "create_new_item"]);
		for (const name of ["mistletoe", "candycane", "ornament"]) {
			const target = active ? c.G.quests[name] : c.G.maps.main.exchange;
			const p = {
				id: "SeasonTest",
				name: "SeasonTest",
				...plain(target),
				q: {},
				s: {},
				p: { stats: { exchanges: {} } },
				items: [{ name, q: c.G.items[name].e }],
				citems: [],
				esize: 41,
			};
			p.id = "SeasonTest";
			c.players = { SeasonTest: p };
			c.socket = { id: "SeasonTest", emit() {} };
			p.socket = c.socket;
			const failures = [];
			c.fail_response = (reason) => failures.push(reason);
			c.success_response = () => {};
			const exchange = socketHandler(c, "exchange");
			exchange({ item_num: 0 });
			assert.deepEqual(failures, [], name);
			assert.equal(p.q.exchange.id, name);
			assert.equal(p.q.exchange.qs, active ? name : undefined);
			assert.equal(p.p.stats.exchanges[name], 1);
		}
	}
});

test("status packets carry boolean flags and navigation rejects a different map variant", async () => {
	const { c } = await browser();
	c.E = { halloween: true };
	c.broadcast = (name, data) => {
		c.sent = { name, data };
	};
	load(c, "node/server_functions.js", ["broadcast_e", "server_bfs"]);
	c.broadcast_e(true);
	assert.deepEqual(plain(c.E.event_flags), plain(c.G.event_flags));
	c.broadcast_e();
	assert.equal(c.sent.name, "server_info");
	c.smap_data = {};
	c.amap_data = {};
	c.G.maps = { main: { key: "christmas", no_bounds: true } };
	c.precomputed_bfs = {
		map_keys: { main: "ordinary" },
		smap_data: { main: { stale: true } },
		amap_data: { main: { stale: true } },
	};
	c.server_bfs("main");
	assert.equal(c.smap_data.main, -1, "the stale ordinary grid is not reused");
	c.precomputed_bfs.map_keys.main = "christmas";
	c.server_bfs("main");
	assert.equal(c.smap_data.main.stale, true, "a matching grid is reused");
});

test("hardcore preserves its Egg Hunt and seasonal respawn and drop overrides", async () => {
	const { c } = await browser({ anniversary: true });
	c.gameplay = "hardcore";
	c.G.event_flags = c.get_event_flags("hardcore");
	c.events = {};
	c.is_pvp = false;
	c.stats = { kills: {} };
	c.D = { drops: c.G.drops, upgrades: c.upgrades, compounds: c.compounds, monster_gold: c.monster_gold };
	load(c, "node/server_functions.js", ["sprocess_game_data", "calculate_xvalue"]);
	c.sprocess_game_data(c.apply_event_flags);
	assert.equal(c.events.egghunt, true);
	assert.equal(c.G.monsters.jr.respawn, 480);
	assert.equal(c.G.monsters.greenjr.respawn, 480);
	assert.equal(c.D.drops.maps.global.filter((row) => row[1] === "goldenegg").length, 1);
	assert.equal(c.D.drops.maps.global.filter((row) => row[1] === "candy0").length, 1);
	assert.equal(c.D.drops.maps.global.filter((row) => row[1] === "anniversarygift").length, 0);
});
