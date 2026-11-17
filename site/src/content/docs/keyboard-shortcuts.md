# Keyboard shortcuts

On macOS use <kbd>⌘</kbd> where this page says <kbd>Ctrl</kbd>/<kbd>⌘</kbd>. Press <kbd>?</kbd> in the app to see the main list.

## Everywhere

| Keys | What it does |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> | Open the command palette: search streams, consumers and buckets, or run an action. |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>B</kbd> | Collapse or expand the sidebar. |
| <kbd>?</kbd> | Show the list of shortcuts. It does nothing while you type in a field. |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>W</kbd> | Close the current tab. Desktop app only. It never closes the window: with no tab open it does nothing. |
| <kbd>Ctrl</kbd> + <kbd>Tab</kbd> | Go to the next tab (also <kbd>Ctrl</kbd> on macOS). Desktop app only. |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> | Go to the previous tab. Desktop app only. |
| <kbd>Esc</kbd> | Close a dialog, a menu, the command palette or the message panel. |
| <kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd> | Move between controls. Inside a dialog the focus stays in the dialog. |

## Command palette

| Keys | What it does |
| --- | --- |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move through the results. |
| <kbd>Enter</kbd> | Run the selected result. |
| <kbd>Esc</kbd> | Close the palette. |

## Tables

These work in every table, such as the lists of streams, consumers and messages, once the table has focus.

| Keys | What it does |
| --- | --- |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Select the previous or next row. |
| <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | Move up or down by one page. |
| <kbd>Home</kbd> / <kbd>End</kbd> | Go to the first or last row. |
| <kbd>Enter</kbd> | Open the selected row. |
| <kbd>←</kbd> / <kbd>→</kbd> | On the resize handle at the right edge of a column header: make the column 10 px narrower or wider (50 px with <kbd>Shift</kbd>). |
| <kbd>Home</kbd> | On the resize handle: reset the column to its default width. |

Columns can also be resized by dragging the handle; double-click it to reset the column. The widths are remembered for each table.

## Message browser

| Keys | What it does |
| --- | --- |
| <kbd>Space</kbd> | Tick or untick the selected message, for copy and export. |
| <kbd>Esc</kbd> | Close the message panel. When the panel is widened with **Expand to read**, the first press restores it. In the filter panel it hides the panel; in the JSON search box it clears the search. |
| <kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>←</kbd> / <kbd>→</kbd> / <kbd>Home</kbd> / <kbd>End</kbd> | On a line of a JSON payload: move between lines, open or close a node. <kbd>Tab</kbd> then reaches **Copy path** and **Copy value** of that line. |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>F</kbd> | Inside the payload of a JSON message: search the JSON. |
| <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> | Show the previous or next message while the message panel has focus. |
| <kbd>Enter</kbd> | In the sequence field: go to that sequence. |
| <kbd>←</kbd> / <kbd>→</kbd> | On the resize handle of the message panel: make it wider or narrower. |
| <kbd>Home</kbd> / <kbd>End</kbd> | On the resize handle: smallest or largest width. |

## Publish

| Keys | What it does |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> | Send, from the payload field of the publish form. |

## Charts

| Keys | What it does |
| --- | --- |
| <kbd>←</kbd> / <kbd>→</kbd> | With a chart focused: read the previous or next sample. |
| <kbd>Esc</kbd> | Hide the value readout. |

## Forms

| Keys | What it does |
| --- | --- |
| <kbd>Enter</kbd> | In the test timeout field of the connection form: store the value without saving the connection. |

## Desktop app menu

The desktop app has a small, fixed menu (hidden until you press <kbd>Alt</kbd>, and always visible in the macOS menu bar). These shortcuts come from it:

| Keys | What it does |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Z</kbd>, <kbd>Shift</kbd> + <kbd>Z</kbd> (or <kbd>Y</kbd> on Windows and Linux), <kbd>X</kbd>, <kbd>C</kbd>, <kbd>V</kbd>, <kbd>A</kbd> | Undo, redo, cut, copy, paste and select all, in text fields and in selected text. |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>+</kbd>, <kbd>-</kbd>, <kbd>0</kbd> | Zoom in, zoom out, reset the zoom. |
| <kbd>F11</kbd> (<kbd>Ctrl</kbd> + <kbd>⌘</kbd> + <kbd>F</kbd> on macOS) | Full screen. |

On macOS the menu also has About, Hide and Quit (<kbd>⌘</kbd> + <kbd>Q</kbd>).

The installed app has no reload and no developer tools: <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>R</kbd>, <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>, <kbd>F5</kbd> and <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> do nothing, so an accidental key press cannot throw away what you were typing. They exist only when running from source with `npm run dev`. <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>W</kbd> is not a window shortcut at all (see above).

## In a browser

[Web mode](/docs/web-mode/) uses the same shortcuts, except three. A browser keeps <kbd>Ctrl</kbd> + <kbd>W</kbd>, <kbd>Ctrl</kbd> + <kbd>Tab</kbd> and <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> for its own tabs, so the page never receives them. Use the studio's tab bar and the close button on a tab instead. A browser may claim other combinations too, and it keeps its own reload, zoom and developer tools.
