// The Witch's Cipher: a daily event at the Witch in Spooky Forest, all year (18:00 on the realm
// clock, published by the event schedule). For the first 20 minutes, kills in four regions drop
// four ingredients; until the end, players brew four-ingredient mixes in her cauldron. Every mix is
// scored against the Witch's secret recipe and the realm shares one clue board. Mixes pay Witch's
// Parcels. Whenever someone cracks the recipe she forgets it at once: a new recipe starts on a clean
// board, so every mix stays a deduction instead of a copy of a known answer. One character per account joins each UTC day, on one realm; the account's claim lives in
// the WitchCipher collection so another realm cannot repeat the day.

var witch_cipher = null; // the live round, mirrored in S.witchcipher
// Today's account claims (loaded from the WitchCipher collection) and drop cooldowns. Memory only:
// after a restart they are read again from Mongo, never from the server snapshot.
var witch_cipher_claims = {};
var witch_cipher_drops = {};

function witch_cipher_rules() {
	return G.events.witchcipher;
}

function witch_cipher_ingredients() {
	return witch_cipher_rules().ingredients.map(function (entry) {
		return entry[0];
	});
}

function witch_cipher_day(now) {
	return new Date(now).toISOString().slice(0, 10);
}

// Mastermind feedback: right = right ingredient in the right place, moved = right ingredient elsewhere.
function witch_cipher_score(secret, mix) {
	var right = 0,
		secret_left = {},
		mix_left = {},
		moved = 0;
	for (var i = 0; i < 4; i++) {
		if (secret[i] === mix[i]) right++;
		else {
			secret_left[secret[i]] = (secret_left[secret[i]] || 0) + 1;
			mix_left[mix[i]] = (mix_left[mix[i]] || 0) + 1;
		}
	}
	for (var name in mix_left) moved += Math.min(mix_left[name], secret_left[name] || 0);
	return { right: right, moved: moved };
}

// Every recipe that still fits all of the round's clues.
function witch_cipher_candidates(history) {
	var names = witch_cipher_ingredients(),
		list = [];
	for (var a = 0; a < 4; a++)
		for (var b = 0; b < 4; b++)
			for (var c = 0; c < 4; c++)
				for (var d = 0; d < 4; d++) {
					var recipe = [names[a], names[b], names[c], names[d]];
					if (
						history.every(function (entry) {
							var score = witch_cipher_score(recipe, entry.mix);
							return score.right === entry.right && score.moved === entry.moved;
						})
					)
						list.push(recipe);
				}
	return list;
}

function witch_cipher_public() {
	if (!witch_cipher) return { live: false };
	var round = witch_cipher,
		rules = witch_cipher_rules(),
		now = Date.now();
	var data = {
		live: now < round.end,
		phase: now < round.gather_end ? "gathering" : "brewing",
		id: round.id,
		start: round.start,
		gather_end: round.gather_end,
		end: round.end,
		board: round.history.slice(-rules.board).map(function (entry) {
			return { mix: entry.mix.slice(), right: entry.right, moved: entry.moved };
		}),
		possible: witch_cipher_candidates(round.history).length,
		mixes: round.history.length,
		cracks: round.cracks.length,
	};
	// The last cracked recipe, shown above the new board
	if (round.cracked) data.cracked = { by: round.cracked.by, recipe: round.cracked.recipe.slice() };
	return data;
}

function witch_cipher_publish() {
	E.witchcipher = witch_cipher_public();
	broadcast_e();
}

function witch_cipher_secret() {
	var names = witch_cipher_ingredients();
	return [0, 1, 2, 3].map(function () {
		return random_one(names);
	});
}

function witch_cipher_start(occurrence) {
	var rules = witch_cipher_rules(),
		names = witch_cipher_ingredients(),
		now = Date.now();
	witch_cipher = S.witchcipher = {
		id: occurrence.id,
		day: witch_cipher_day(now),
		start: now,
		gather_end: now + rules.gathering * 1000,
		end: now + rules.duration * 1000,
		secret: witch_cipher_secret(),
		history: [],
		cracks: [],
		cracked: null,
	};
	witch_cipher_claims = {};
	witch_cipher_drops = {};
	events.witchcipher = true;
	broadcast("server_message", localization.message("server.witchcipher.started", {}, { color: "#AF6AE2" }));
	broadcast("game_event", { name: "witchcipher", map: "halloween", x: G.quests.witch.x, y: G.quests.witch.y });
	witch_cipher_publish();
}

// Restores a round after a restart; a round that ended while the server was down just finishes.
function witch_cipher_restore() {
	if (!S.witchcipher) return;
	witch_cipher = S.witchcipher;
	delete witch_cipher.claims; // older snapshots carried claims; Mongo is the record
	// Older snapshots kept one cracked recipe as the live secret
	if (!witch_cipher.cracks) {
		witch_cipher.cracks = [];
		if (witch_cipher.cracked) {
			witch_cipher.cracked.recipe = witch_cipher.secret.slice();
			witch_cipher.cracks.push(witch_cipher.cracked);
			witch_cipher.secret = witch_cipher_secret();
			witch_cipher.history = [];
		}
	}
	witch_cipher_claims = {};
	witch_cipher_drops = {};
	if (Date.now() >= witch_cipher.end) return witch_cipher_finish();
	events.witchcipher = true;
	E.witchcipher = witch_cipher_public();
}

function witch_cipher_finish() {
	var round = witch_cipher;
	events.witchcipher = false;
	if (round && !round.cracks.length)
		broadcast(
			"server_message",
			localization.message(
				"server.witchcipher.over_uncracked",
				{ recipe: round.secret.map((name) => G.items[name].name).join(", ") },
				{ color: "#AF6AE2" },
			),
		);
	else broadcast("server_message", localization.message("server.witchcipher.over", {}, { color: "#AF6AE2" }));
	E.witchcipher = round ? Object.assign(witch_cipher_public(), { live: false }) : { live: false };
	witch_cipher = S.witchcipher = null;
	for (var id in players) if (players[id].witchcipher) ((players[id].witchcipher = null), resend(players[id], "u+cid"));
	broadcast_e();
}

function witch_cipher_tick() {
	if (!witch_cipher) return;
	var now = Date.now();
	if (now >= witch_cipher.end) return witch_cipher_finish();
	if (!witch_cipher.brewing_notice && now >= witch_cipher.gather_end) {
		witch_cipher.brewing_notice = true;
		broadcast("server_message", localization.message("server.witchcipher.gathering_over", {}, { color: "#AF6AE2" }));
		witch_cipher_publish();
	}
}

// What the joined character sees about its own day (character.witchcipher in CODE).
function witch_cipher_status(claim) {
	var rules = witch_cipher_rules();
	return {
		day: claim.day,
		name: claim.name,
		mixes: claim.mixes,
		mixes_left: Math.max(0, rules.mixes - claim.mixes),
		parcels: claim.parcels,
	};
}

async function witch_cipher_claim(player, create) {
	var collection = db.collection("WitchCipher"),
		day = witch_cipher_day(Date.now()),
		id = "claim:" + player.owner + ":" + day;
	if (create) {
		try {
			await collection.insertOne({
				_id: id,
				owner: player.owner,
				day: day,
				character: player.real_id,
				name: player.name,
				server: server_id,
				mixes: 0,
				parcels: 0,
				created: new Date(),
			});
		} catch (error) {
			if (error.code !== 11000) throw error;
		}
	}
	return await collection.findOne({ _id: id });
}

// Saves the claim's counts; $max keeps writes that land out of order from lowering them. A failed
// write is retried, because after a restart the claim is read back from Mongo.
function witch_cipher_save_claim(owner, claim, tries) {
	db.collection("WitchCipher")
		.updateOne({ _id: "claim:" + owner + ":" + claim.day }, { $max: { mixes: claim.mixes, parcels: claim.parcels } })
		.catch(function (error) {
			log_trace("witchcipher save", error);
			if (tries < 20) setTimeout(() => witch_cipher_save_claim(owner, claim, tries + 1), 3000);
		});
}

// Keeps the larger counts: a Mongo read that started before a brew must not hand back spent mixes.
function witch_cipher_remember(claim) {
	var live = witch_cipher_claims[claim.owner];
	if (live && live.character === claim.character && live.day === claim.day) {
		live.mixes = Math.max(live.mixes, claim.mixes);
		live.parcels = Math.max(live.parcels, claim.parcels);
		return live;
	}
	return (witch_cipher_claims[claim.owner] = {
		character: claim.character,
		name: claim.name,
		day: claim.day,
		mixes: claim.mixes,
		parcels: claim.parcels,
	});
}

// After a restart, or on login during a round, the joined character finds its day again.
function witch_cipher_reload(player) {
	if (!witch_cipher || witch_cipher_claims[player.owner] || Date.now() >= witch_cipher.end) return;
	witch_cipher_claim(player, false)
		.then(function (claim) {
			if (!claim || !witch_cipher || claim.day !== witch_cipher.day || claim.character !== player.real_id) return;
			if (claim.server !== server_id) return;
			witch_cipher_remember(claim);
			if (player.dc) return;
			player.witchcipher = witch_cipher_status(witch_cipher_claims[player.owner]);
			resend(player, "u+cid+nc");
		})
		.catch((error) => log_trace("witchcipher reload", error));
}

// join("witchcipher"): this character takes part today. Idempotent for the same character.
async function witch_cipher_join(player) {
	if (!witch_cipher || Date.now() >= witch_cipher.end) return { failed: true, reason: "witchcipher_not_live" };
	// The same rules as join(), for the Witch's own JOIN request too
	if (player.type == "merchant") return { failed: true, reason: "no_merchants" };
	if (player.s.hopsickness) return { failed: true, reason: "cant_when_sick" };
	if (player.user) return { failed: true, reason: "cant_in_bank" };
	var claim = await witch_cipher_claim(player, true);
	if (!claim) return { failed: true, reason: "invalid" };
	if (claim.character !== player.real_id)
		return Object.assign(
			{ failed: true, reason: "witchcipher_claimed" },
			localization.message("server.witchcipher.claimed_by", { name: String(claim.name) }),
		);
	if (claim.server !== server_id)
		return Object.assign(
			{ failed: true, reason: "witchcipher_elsewhere" },
			localization.message("server.witchcipher.claimed_elsewhere", { server: String(claim.server.slice(3)) }),
		);
	if (!witch_cipher || claim.day !== witch_cipher.day) return { failed: true, reason: "witchcipher_not_live" };
	player.witchcipher = witch_cipher_status(witch_cipher_remember(claim));
	resend(player, "u+cid");
	return Object.assign({ success: true, joined: true }, player.witchcipher);
}

// The account's day without joining: who took part, where, and how many mixes are left.
async function witch_cipher_info(player) {
	var claim = await witch_cipher_claim(player, false),
		rules = witch_cipher_rules();
	var info = { mixes: rules.mixes, mixes_left: rules.mixes, live: !!(witch_cipher && Date.now() < witch_cipher.end) };
	if (claim)
		Object.assign(info, {
			joined: true,
			name: claim.name,
			server: claim.server.slice(3),
			mixes_left: Math.max(0, rules.mixes - claim.mixes),
			parcels: claim.parcels,
		});
	return info;
}

function witch_cipher_near(player) {
	if (player.computer) return true;
	var witch = G.quests.witch;
	return !!witch && player.map === witch.map && distance(player, witch) <= B.sell_dist;
}

// One mix in the cauldron: four ingredient names in order. Synchronous, so the inventory checked
// is the inventory consumed. The claim's mix count is saved after the reward.
function witch_cipher_brew(player, names) {
	var rules = witch_cipher_rules(),
		round = witch_cipher,
		now = Date.now();
	if (!round || now >= round.end) return { failed: true, reason: "witchcipher_not_live" };
	var claim = witch_cipher_claims[player.owner];
	if (!claim || claim.character !== player.real_id) return { failed: true, reason: "witchcipher_join" };
	if (claim.mixes >= rules.mixes) return { failed: true, reason: "witchcipher_no_mixes" };
	if (!witch_cipher_near(player)) return { failed: true, reason: "distance" };
	if (player.user) return { failed: true, reason: "cant_in_bank" };
	var valid = witch_cipher_ingredients();
	if (!is_array(names) || names.length !== 4 || names.some((name) => !valid.includes(name)))
		return { failed: true, reason: "invalid" };
	var needed = {};
	names.forEach(function (name) {
		needed[name] = (needed[name] || 0) + 1;
	});
	for (var name in needed) {
		var have = 0;
		player.items.forEach(function (item) {
			if (item && item.name === name && !item.l) have += item.q || 1;
		});
		if (have < needed[name]) return { failed: true, reason: "witchcipher_ingredients", item: name };
	}
	for (var name in needed) {
		var left = needed[name];
		for (var i = 0; i < player.items.length && left; i++) {
			var item = player.items[i];
			if (!item || item.name !== name || item.l) continue;
			var take = Math.min(left, item.q || 1);
			consume(player, i, take);
			left -= take;
		}
	}

	var key = names.join(","),
		tried = round.history.some((entry) => entry.mix.join(",") === key),
		score = witch_cipher_score(round.secret, names),
		informative = !tried && witch_cipher_candidates(round.history).some((recipe) => recipe.join(",") === key),
		cracked_now = score.right === 4,
		pay = rules.payout,
		parcels = cracked_now ? pay.exact + pay.crack : informative ? pay.informative : pay.other;
	// Two cracks in one day must not lift an account past the daily Parcels
	parcels = Math.max(0, Math.min(parcels, rules.max_parcels - claim.parcels));
	if (cracked_now) {
		// She forgets it at once: the next recipe starts on a clean board
		round.cracked = { by: player.name, at: now, recipe: round.secret.slice() };
		round.cracks.push(round.cracked);
		round.secret = witch_cipher_secret();
		round.history = [];
		broadcast(
			"server_message",
			localization.message("server.witchcipher.cracked", { player: String(player.name) }, { color: "#F59A3C" }),
		);
	} else if (!tried)
		round.history.push({ mix: names.slice(), right: score.right, moved: score.moved, by: player.name });
	claim.mixes += 1;
	claim.parcels += parcels;
	if (parcels) {
		var reward = create_new_item("witchparcel", parcels);
		add_item(player, reward, { announce: false });
		player.socket.emit("game_log", item_message("server.item.received", reward, {}, { color: "#AF6AE2" }));
	}
	player.witchcipher = witch_cipher_status(claim);
	resend(player, "reopen+nc+inv+u+cid");
	witch_cipher_save_claim(player.owner, claim, 0);
	witch_cipher_publish();
	return {
		success: true,
		mix: names.slice(),
		right: score.right,
		moved: score.moved,
		informative: informative,
		cracked: cracked_now,
		parcels: parcels,
		mixes_left: player.witchcipher.mixes_left,
	};
}

// A fixed 65% roll on a kill in one of the four regions, at most once every 20 seconds, only for
// the account's joined character during gathering. Luck, party size and drop multipliers don't apply.
function witch_cipher_kill(player, monster) {
	var round = witch_cipher,
		now = Date.now();
	if (!round || now >= round.gather_end || !player || player.npc) return;
	var claim = witch_cipher_claims[player.owner];
	if (!claim || claim.character !== player.real_id) return;
	var rules = witch_cipher_rules(),
		entry = rules.ingredients.find((pair) => pair[1].includes(monster.type));
	var last = witch_cipher_drops[player.owner];
	if (!entry || (last && now - last < rules.drop_cooldown * 1000)) return;
	if (Math.random() >= rules.drop) return;
	witch_cipher_drops[player.owner] = now;
	var item = create_new_item(entry[0]);
	add_item(player, item, { announce: false });
	player.socket.emit("game_log", item_message("server.item.found", item, {}, { color: "#AF6AE2" }));
	resend(player, "reopen+nc+inv");
}

async function witch_cipher_interaction(player, data) {
	if (data.action === "join") return await witch_cipher_join(player);
	if (data.action === "info") return await witch_cipher_info(player);
	if (data.action === "brew") return witch_cipher_brew(player, data.items);
	return { failed: true, reason: "invalid" };
}
