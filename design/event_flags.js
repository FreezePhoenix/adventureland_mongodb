// Change seasonal switches here, then deploy and restart the game servers.
// Definitions, map geometry and navigation must be rebuilt with the same flags.
var event_flags = {
	anniversary: false,
	holidayseason: false,
	lunarnewyear: false,
	valentines: false,
	egghunt: false,
	halloween: true,
};

// Preserve the game modes: Hardcore includes the Egg Hunt; Dungeon disables all seasons.
var event_flag_overrides = { hardcore: { egghunt: true }, dungeon: false };

function get_event_flags(gameplay) {
	var flags = Object.assign({}, event_flags, event_flag_overrides[gameplay]);
	for (var name in flags) {
		if (typeof flags[name] !== "boolean") throw new Error("Event flag must be boolean: " + name);
		if (event_flag_overrides[gameplay] === false) flags[name] = false;
	}
	return flags;
}
