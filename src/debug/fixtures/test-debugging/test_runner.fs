extends ScriptRunner

# Foundry Test Adapter Protocol v1 runner for selected-test DAP conformance.
# It has no framework dependency: opaque IDs choose deterministic pass, failure,
# breakpoint, cancellation, and restart behavior.

func run(args: PackedStringArray) -> int:
	if args.size() < 2 or args[0] != "adapter" or args[1] != "run":
		return 2

	var report: String = ""
	var protocol_version: String = ""
	var selections := PackedStringArray()
	var index: int = 2
	while index < args.size():
		if index + 1 >= args.size():
			return 2
		var argument: String = args[index]
		var value: String = args[index + 1]
		index += 2
		if argument == "--report":
			report = value
		elif argument == "--protocol-version":
			protocol_version = value
		elif argument == "--select":
			selections.append(value)
		else:
			return 2

	if protocol_version != "1" or report.is_empty() or selections.is_empty():
		return 2
	for selection in selections:
		if not _known_id(selection):
			return 2

	var file := FileAccess.open(report, FileAccess.WRITE)
	if file == null:
		return 2
	file.store_string("TAP version 13\n")
	file.store_string("# foundry-test-adapter: 1\n")
	file.store_string("1.." + str(selections.size()) + "\n")
	file.flush()

	var selected_count: int = selections.size()
	var inspection_value: int = 42
	if selected_count < 0 or inspection_value < 0:
		return 2

	var result: int = 0
	for point_index in selections.size():
		var selected_id: String = selections[point_index]
		var passed: bool = not selected_id.begins_with("fail::")
		_store_point(file, point_index + 1, selected_id, passed)
		if not passed:
			result = 1
		if selected_id == "cancel::first":
			while true:
				OS.delay_msec(20)
	file.close()
	return result

func _known_id(test_id: String) -> bool:
	return (
		test_id.begins_with("pass::")
		or test_id.begins_with("fail::")
		or test_id.begins_with("breakpoint::")
		or test_id.begins_with("restart::")
		or test_id == "cancel::first"
		or test_id == "cancel::never"
	)

func _store_point(file: FileAccess, number: int, test_id: String, passed: bool) -> void:
	var status: String = "ok "
	if not passed:
		status = "not ok "
	var unit: String = status + str(number) + " - selected_test.point_" + str(number) + "\n"
	unit += "  ---\n"
	if not passed:
		unit += "  message: \"selected test failed\"\n"
	unit += "  _foundry:\n"
	unit += "    id: \"" + test_id + "\"\n"
	unit += "    duration_ms: 0\n"
	unit += "    status_detail: \"\"\n"
	unit += "  ...\n"
	file.store_string(unit)
	file.flush()
