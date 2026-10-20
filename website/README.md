# Leaderboard website

This website shows the leaderboard of Underetasje 5 and the live status of the
five rooms (U1 to U5). It runs on the 9:16 screen in the hall, and on phones and
PCs on the local network. It uses React Router 8 (framework mode, server
rendering) and the Vite+ toolchain (`vp`).

The web server reads `GET /leaderboard` and `GET /state` from the control room
server (`../backend`). The browser does not connect to the control room server.
The page loads the data again each 2 seconds.

If the control room server does not answer, the page shows example data and the
label "Eksempeldata". If the server stops answering after live data, the page
keeps the last data and shows "Mistet kontakt".

## Commands

Do these commands in the `website/` directory.

| Command        | Result                                                      |
| -------------- | ----------------------------------------------------------- |
| `vp install`   | Installs the dependencies.                                  |
| `vp dev`       | Starts the development server on port 5173 (all addresses). |
| `vp check`     | Runs format, lint and type checks.                          |
| `vp build`     | Makes the production build in `build/`.                     |
| `vp run start` | Starts the production server (port 3000).                   |

## Configuration

| Variable           | Default                 | Meaning                                         |
| ------------------ | ----------------------- | ----------------------------------------------- |
| `CONTROL_ROOM_URL` | `http://127.0.0.1:7321` | Address of the control room server.             |
| `PORT`             | `3000`                  | Port of the production server (`vp run start`). |

## Addresses

| Address  | Use                                                                               |
| -------- | --------------------------------------------------------------------------------- |
| `/?hall` | The hall screen: no cursor, the screen stays on, the phone address in the footer. |
| `/`      | Phones and PCs. On a narrow screen the page scrolls.                              |
| `/?fx=0` | No shader effects (for slow hardware).                                            |

## Parts

| File                                       | Function                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `app/routes/tavle.tsx`                     | The page: loader, polling, status, layout.                                   |
| `app/lib/control-room.server.ts`           | Reads the control room server (server only).                                 |
| `app/lib/demo.ts`                          | Example data when the server does not answer.                                |
| `app/components/Leaderboard.tsx`           | The list in the pumpkin frame. Hides the rows that do not fit on one screen. |
| `app/components/Rooms.tsx`                 | The five room cards with live timers.                                        |
| `app/components/Effects.tsx`, `shaders.ts` | WebGL layers: moon, fog, embers, bats.                                       |
| `app/app.css`                              | All styles. Tokens from the Halloween-prosjektet design system.              |

The Google Fonts (Anton, Pixelify Sans) need internet. Without internet, the
browser uses Impact and a monospace font.
