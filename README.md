# THE VAULT

## Run the lobby

From this folder, run:

```sh
node server.js
```

Then open [http://localhost:4173](http://localhost:4173). The server uses only Node.js built-in modules; no package install is needed.

To play with others on the same network, have everyone open the host computer's LAN address on port `4173`, then join with the six-character room code. Create a room and start with AI to practice solo. The room host can rotate roles before starting.

## Heist flow

Clear the signal as Hacker, wait for the Lookout to call CLEAR, then breach as Muscle. Each level has its own timer and patrol pattern. Wrong or premature actions are recorded; a mistake during a guard window can trigger a guard sighting. The final report shows active time, wrong actions, and guard sightings.

If a player disconnects during a live heist, the server pauses the mission timer for up to 30 seconds. Reopening the same browser session reconnects the player. Room and game state are held in server memory, so they reset when the Node process stops.

## Crew tools and records

The lobby's **Fastest Heists** board shows the five quickest successful crews across all three levels. Records are saved in `leaderboard.json`, so they survive a server restart. The first successful completion creates the file entry; solo practice runs can also set a record.

During a live run, **Quick Comms** sends CLEAR, WAIT, and HELP callouts to every player in the room. The Hacker can trigger **System Overload** once per level to scramble all clients' displays and suppress patrol warnings briefly. The board is shared by rooms hosted by the same server process; use a shared database if you later deploy multiple server instances.

Web Audio starts only after the first screen click to meet browser autoplay rules. That click starts the looping synth theme; every enabled button gives a short beep, and nearby guards trigger a repeating siren. The top-right sound button mutes and restores music and effects together, and remembers the setting in that browser.
