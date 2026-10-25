// Built-in functions and predefined constants, mirroring auric-lang/compiler/prelude.py
// (types) with names and docs from auric-lang/docs/language.md (hover, completion).

export interface BuiltinParam {
    name: string;
    type: string;
}

export interface Builtin {
    params: BuiltinParam[];
    ret: string;
    doc: string;
}

function p(name: string, type: string): BuiltinParam {
    return { name, type };
}

export const BUILTINS: Record<string, Builtin> = {
    screen: { params: [p("which", "int")], ret: "void",
        doc: "Draw on `TOP` or `BOTTOM` from now on. Apps start on the top screen (400x240); the bottom one is 320x240." },
    print: { params: [p("text", "string"), p("x", "int"), p("y", "int"), p("color", "int")], ret: "void",
        doc: "Draw `text` at pixel `(x, y)` in the 8x8 font." },
    print_int: { params: [p("value", "int"), p("x", "int"), p("y", "int"), p("color", "int")], ret: "void",
        doc: "Draw a signed decimal number at pixel `(x, y)`." },
    clear: { params: [p("color", "int")], ret: "void",
        doc: "Fill the screen; remembers `color` as that screen's text background." },
    fill_rect: { params: [p("x", "int"), p("y", "int"), p("w", "int"), p("h", "int"), p("color", "int")], ret: "void",
        doc: "Fill a rectangle. Drawing past an edge is clipped." },
    wait_key: { params: [p("button", "int")], ret: "void",
        doc: "Block until `button` (a `KEY_*` mask) is newly pressed." },
    delay: { params: [p("cycles", "int")], ret: "void",
        doc: "Busy-wait about `cycles` iterations. Keeps HOME responsive in idle loops; pace games with `millis()` instead." },
    keys_down: { params: [], ret: "int",
        doc: "Buttons newly pressed since the last call (an edge). Test with `(keys_down() & KEY_A) != 0`." },
    keys_held: { params: [], ret: "int",
        doc: "Buttons currently held (a level)." },
    touch_down: { params: [], ret: "bool",
        doc: "A touch began since the last call (an edge, like `keys_down`)." },
    touch_held: { params: [], ret: "bool",
        doc: "The bottom screen is being touched." },
    touch_up: { params: [], ret: "bool",
        doc: "The stylus lifted since the last call." },
    touch_x: { params: [], ret: "int",
        doc: "x of the touch, or of the last one (`-1` before the first touch)." },
    touch_y: { params: [], ret: "int",
        doc: "y of the touch, or of the last one (`-1` before the first touch)." },
    touch_in: { params: [p("x", "int"), p("y", "int"), p("w", "int"), p("h", "int")], ret: "bool",
        doc: "The touch position lies inside the rectangle." },
    buffered: { params: [p("on", "bool")], ret: "void",
        doc: "Draw off-screen until `present()`. Call `buffered(true)` once at startup." },
    present: { params: [], ret: "void",
        doc: "Show the off-screen frame on both screens (only the ones drawn on since the last `present()`)." },
    rand: { params: [p("n", "int")], ret: "int",
        doc: "Pseudo-random int in `[0, n)`, seeded from the console clock." },
    millis: { params: [], ret: "int",
        doc: "Milliseconds since the app started, not counting time with the lid closed." },
    load_sound: { params: [p("path", "string")], ret: "int",
        doc: "Read a WAV from the SD card (path from the card's root) and return its handle, or `-1` if it cannot." },
    play_sound: { params: [p("handle", "int")], ret: "void",
        doc: "Play a sound once, on a free effect voice." },
    play_music: { params: [p("handle", "int")], ret: "void",
        doc: "Loop a sound on the music voice, replacing any music already playing." },
    stop_music: { params: [], ret: "void",
        doc: "Silence the music." },
    stop_sounds: { params: [], ret: "void",
        doc: "Silence every effect." },
    net_connect: { params: [], ret: "bool",
        doc: "Join the Wi-Fi network saved in Settings. `false` if it cannot; `net_error()` says why." },
    net_online: { params: [], ret: "bool",
        doc: "The network link is up." },
    net_error: { params: [], ret: "string",
        doc: "Why the last network call failed. Changes at the next request." },
    net_address: { params: [], ret: "string",
        doc: "The console's address on the network (`\"\"` when not connected)." },
    http_get: { params: [p("url", "string")], ret: "int",
        doc: "An HTTP GET (plain `http://` only). Returns the reply's status, or `0` if none came." },
    http_post: { params: [p("url", "string"), p("body", "string")], ret: "int",
        doc: "An HTTP POST. An empty body sends the `http_param`s as a form; a body starting with `{` or `[` is sent as JSON." },
    http_param: { params: [p("name", "string"), p("value", "string")], ret: "void",
        doc: "Add a parameter to the next request (`?name=value&...`, encoded for you)." },
    http_param_int: { params: [p("name", "string"), p("value", "int")], ret: "void",
        doc: "Add a number parameter to the next request." },
    http_header: { params: [p("name", "string"), p("value", "string")], ret: "void",
        doc: "Add a header to the next request." },
    http_text: { params: [], ret: "string",
        doc: "The last reply's body. Changes at the next request." },
    http_length: { params: [], ret: "int",
        doc: "The last reply's size in bytes." },
    http_lines: { params: [], ret: "int",
        doc: "How many lines the last reply has." },
    http_line: { params: [p("n", "int")], ret: "string",
        doc: "Line `n` of the last reply, from 0, without its line end. Changes at the next request." },
    http_save: { params: [p("path", "string")], ret: "bool",
        doc: "Write the last reply to the SD card." },
    http_download: { params: [p("url", "string"), p("path", "string")], ret: "bool",
        doc: "Save a file of any size to the SD card, in pieces." },
    json_has: { params: [p("path", "string")], ret: "bool",
        doc: "The value at `path` is in the last reply, read as JSON. Paths look like `\"items.0.name\"`." },
    json_int: { params: [p("path", "string")], ret: "int",
        doc: "A value of the last reply as a number (rounded; reads `\"17\"` too). `0` when missing." },
    json_float: { params: [p("path", "string")], ret: "float",
        doc: "A value of the last reply as a float. `0.0` when missing." },
    json_bool: { params: [p("path", "string")], ret: "bool",
        doc: "A value of the last reply as a truth value. `false` when missing." },
    json_string: { params: [p("path", "string")], ret: "string",
        doc: "A value of the last reply as text. `\"\"` when missing. Changes at the next request." },
    json_count: { params: [p("path", "string")], ret: "int",
        doc: "The elements of an array, or the members of an object, at `path`." },
    json_index: { params: [p("n", "int")], ret: "void",
        doc: "What `#` stands for in the JSON paths after it, to walk through an array." },
};

export interface Constant {
    type: string;
    value: string;
    doc: string;
}

function colour(value: string): Constant {
    return { type: "int", value, doc: "Colour, packed `0xRRGGBB`." };
}

function button(bit: number): Constant {
    return { type: "int", value: `1 << ${bit}`, doc: "Button mask for `keys_down()`, `keys_held()` and `wait_key()`." };
}

export const CONSTANTS: Record<string, Constant> = {
    BLACK: colour("0x000000"),
    WHITE: colour("0xFFFFFF"),
    RED: colour("0xFF0000"),
    GREEN: colour("0x00FF00"),
    BLUE: colour("0x0000FF"),
    CYAN: colour("0x00FFFF"),
    MAGENTA: colour("0xFF00FF"),
    YELLOW: colour("0xFFFF00"),
    ORANGE: colour("0xFFA000"),
    AURORA: colour("0x64E8C8"),
    GRAY: colour("0xA0A0A0"),
    DARK_GRAY: colour("0x505050"),
    TOP: { type: "int", value: "0", doc: "The top screen (400x240), for `screen()`." },
    BOTTOM: { type: "int", value: "1", doc: "The bottom screen (320x240, the touchscreen), for `screen()`." },
    KEY_A: button(0),
    KEY_B: button(1),
    KEY_SELECT: button(2),
    KEY_START: button(3),
    KEY_RIGHT: button(4),
    KEY_LEFT: button(5),
    KEY_UP: button(6),
    KEY_DOWN: button(7),
    KEY_R: button(8),
    KEY_L: button(9),
    KEY_X: button(10),
    KEY_Y: button(11),
};

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function builtinNamed(name: string): Builtin | undefined {
    return hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
}

export function constantNamed(name: string): Constant | undefined {
    return hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined;
}

export const TYPE_NAMES = ["int", "float", "bool", "string"];

export const KEYWORD_DOCS: Record<string, string> = {
    fn: "Declare a function: `fn name(param: type, ...) -> ret_type { ... }`. Omit `-> ret_type` for a function that returns nothing. Every program needs `fn main()`.",
    let: "Declare a variable: `let x = 1;`, `let y: float = 3.5;`, or a zero-filled array `let board: int[200];`. Outside a function it is a global.",
    if: "`if cond { ... } else if other { ... } else { ... }`. The condition must be `bool` and is not parenthesized.",
    else: "The branch taken when the `if` condition is false.",
    while: "`while cond { ... }` repeats while the `bool` condition holds. Auric has no `for` loop.",
    return: "Leave the function: `return;` in a void function, `return value;` otherwise.",
    break: "Leave the innermost loop.",
    continue: "Go to the next iteration of the innermost loop.",
    true: "The `bool` value true.",
    false: "The `bool` value false.",
    int: "32-bit signed integer.",
    float: "32-bit float. Never mixed with `int` in one expression: there are no implicit conversions.",
    bool: "`true` or `false`. Conditions must be `bool`.",
    string: "Immutable text. `==` and `!=` compare strings by their text.",
};
