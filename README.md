# To-Do

A lightweight, dependency-free to-do list that runs entirely in your browser.

## Features

- Add, complete, edit (double-click), and delete tasks
- Filter by All / Active / Done with live counts
- Progress bar showing completion
- Drag to reorder tasks in the All view
- Light and dark themes (follows your system by default)
- Tasks persist in `localStorage`; no account, server, or build step
- Responsive layout and keyboard support (`/` focuses the input)

## Usage

Open `index.html` in any modern browser. That's it.

Optionally serve it locally:

```sh
python -m http.server 8000
# then visit http://localhost:8000
```

## Notes

Tasks are tied to the browser and origin you use. Clearing site data or
opening the file from a different browser/path means a separate list.

## Tech

One file: HTML, CSS, and vanilla JavaScript. No dependencies.
