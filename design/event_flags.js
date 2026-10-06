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

// Hardcore has always included the Egg Hunt, independently of the normal season.
var event_flag_overrides = { hardcore: { egghunt: true } };

function get_event_flags(gameplay) {
	var flags = Object.assign({}, event_flags, event_flag_overrides[gameplay]);
	for (var name in flags) {
		if (typeof flags[name] !== "boolean") throw new Error("Event flag must be boolean: " + name);
	}
	return flags;
}
