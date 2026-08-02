extends Node

var member_value: int = 35

func _ready() -> void:
	var local_value: int = 7
	member_value += local_value - local_value
	outer_step_target()
	get_tree().quit(0)

func outer_step_target() -> void:
	var outer_marker: int = 11
	inner_step_target()
	member_value += outer_marker - outer_marker

func inner_step_target() -> void:
	var inner_marker: int = 13
	member_value += inner_marker - inner_marker
