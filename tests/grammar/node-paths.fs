# SYNTAX TEST "source.foundryscript"

var sprite = $Sprite2D
#            ^ keyword.operator.getnode.foundryscript
#             ^^^^^^^^ variable.other.nodepath.foundryscript

var child = $Enemy/Health
#            ^^^^^^^^^^^^ variable.other.nodepath.foundryscript

var unique = %HealthBar
#            ^ keyword.operator.getnode.foundryscript

var quoted = $"Some Node/Child"
#            ^ keyword.operator.getnode.foundryscript
#             ^ punctuation.definition.string.begin.foundryscript

var e = $Player/for
#               ^^^ - keyword.control.foundryscript

var g = $Node/class
#             ^^^^^ - keyword.declaration.foundryscript

var h = %Unique/match
#               ^^^^^ - keyword.control.foundryscript
