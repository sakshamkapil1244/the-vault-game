# 🏦 THE VAULT: Co-op Heist

A real-time multiplayer cooperative heist game for 2-4 players. Communication is key, as each player gets a unique perspective and role. Crack the vault within 3 minutes before the guards catch you!

## 🚀 Live Demo
**Play it here:** [https://the-vault-game.onrender.com](https://the-vault-game.onrender.com)
*(Note: The server may take up to 50 seconds to wake up on the first load due to Render's free tier. Once loaded, it runs smoothly.)*

## ✨ Key Features
- **Asymmetrical Roles:** Players are assigned distinct roles (Hacker, Muscle, Lookout) with unique screens and tasks.
- **Real-time Sync:** Powered by Socket.io, ensuring every player's screen is perfectly synced.
- **Multi-Level Heist:** 3 levels of increasing difficulty, with changing guard patterns and timers.
- **Global Leaderboard:** Top 5 fastest successful heists are saved and displayed.
- **In-Game Quick Chat:** Communicate instantly with "Clear!", "Wait!", or "Help!" even without voice chat.
- **Immersive Audio:** Built with the Web Audio API for dynamic sound effects and a looping synthwave theme.
- **Robust Edge Cases:** Handles player disconnections gracefully (pauses the timer for 30 seconds to allow reconnection).
- **AI Bots:** Solo mode allows players to fill empty slots with AI companions for practice.

## 🎮 How to Play
1. **Create or Join a Room:** One player creates a room and shares the 4-letter code (e.g., `DVUL`).
2. **Understand Your Role:**
   - 👨‍💻 **HACKER:** Sees a scrambled 4-digit code. Must guide the Muscle on which buttons to press.
   - 💪 **MUSCLE:** Controls the vault buttons. Must wait for the Lookout to say it's safe.
   - 👁️ **LOOKOUT:** Watches the mini-map and guards. Warns the team of incoming danger.
3. **Communicate:** Use voice chat or the in-game Quick Chat buttons. Teamwork is everything!
4. **Win:** Crack the 3-level vault within the time limit to escape with the loot.

## 🛠️ Tech Stack
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (Canvas API)
- **Backend:** Node.js, Express.js, Socket.io (WebSockets)
- **Deployment:** Render

## 💻 Run Locally
If you want to run this project on your local machine:

1. Clone the repository:
   ```bash
   git clone https://github.com/sakshamkapil1244/the-vault-game.git
