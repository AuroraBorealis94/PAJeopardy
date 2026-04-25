const express = require("express");
const app = express();
const http = require("http").createServer(app);

app.use("/characters", express.static("characters"));
app.use("/fonts", express.static("fonts"));
app.use("/backgrounds", express.static("backgrounds"));
app.use("/sprites", express.static("sprites"));
app.use("/confetti", express.static("public/confetti"));

let GAME_SESSION = Date.now();
const disconnectTimers = new Map();

// BRIDGE FROM SOCKET.IO TO WEBSOCKET
const WebSocket = require("ws");
const wss = new WebSocket.Server({ server: http });

wss.on("connection", (ws) => {
    ws.isUnity = true;
    console.log("Unity connected via WebSocket");
});

// SOCKET.IO
const io = require("socket.io")(http, {
    cors: {
        origin: "*"
    }
});

// CLOUD SERVER
const PORT = process.env.PORT || 3000;

// MAIN GAME STATE
const game = {
    players: [],
    state: "lobby",
    board: {}
};

// CHARACTER STORAGE
const characters = [
    { name: "The Boss", front: "/characters/thebossfront.png", back: "/characters/thebossback.png" },
    { name: "Janice Mowes", front: "/characters/janicemowesfront.png", back: "/characters/janicemowesback.png" },
    { name: "Tricerex", front: "/characters/tricerexfront.png", back: "/characters/tricerexback.png" },
    { name: "Fancy Dancer", front: "/characters/fancydancerpinkfront.png", back: "/characters/fancydancerpinkback.png" },
    { name: "Deerhead", front: "/characters/deerheadfront.png", back: "/characters/deerheadback.png" },
    { name: "Caity Satyr", front: "/characters/caitysatyrfront.png", back: "/characters/caitysatyrback.png" },
    { name: "The Holy Spirit", front: "/characters/jesusfront.png", back: "/characters/jesusback.png" },
    { name: "The Newlyweds", front: "/characters/thenewlywedsfront.png", back: "/characters/thenewlywedsback.png" },
    { name: "Lorenzo", front: "/characters/lorenzofront.png", back: "/characters/lorenzoback.png" },
    { name: "Wise Old Boy", front: "/characters/oldsawyerfront.png", back: "/characters/oldsawyerback.png" },
    { name: "The Guitarist", front: "/characters/theguitaristfront.png", back: "/characters/theguitaristback.png" }
];

// LOCKED CHARACTERS
const lockedCharacters = new Set();

// CLUE STORAGE (filled when game starts)
const cluePool = {
    "Category A": {
        200: [
            { clue: "A small land animal known for burrowing", answer: "rabbit" },
            { clue: "A fast desert mammal", answer: "hare" }
        ],
        400: [
            { clue: "This planet is closest to the sun", answer: "mercury" }
        ]
    },
    "Category B": {
        200: [
            { clue: "Water freezes at temperature in Celsius", answer: "0" }
        ]
    }
};

// WEBSOCKET TO UNITY
function broadcastToUnity(data) {
    const message = JSON.stringify(data);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// GENERATE BOARD
function generateBoard() {
    game.board = {};

    for (let category in cluePool) {
        game.board[category] = {};

        for (let value in cluePool[category]) {
            const options = cluePool[category][value];

            const random = options[Math.floor(Math.random() * options.length)];

            game.board[category][value] = {
                clue: random.clue,
                answer: random.answer,
                used: false
            };
        }
    }
}

function resetGameState() {
    game.players = [];
    game.state = "lobby";
    game.board = {};
    lockedCharacters.clear();

    GAME_SESSION = Date.now();
}

// ROOM CODE
const ROOM_CODE = "PA26";
console.log("Room code for players to join:", ROOM_CODE);

// WEBPAGE
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// NEW CONNECTION
io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);
    socket.data.joined = false;
    socket.isUnity = false;
    // SEND INFO TO WEB
    socket.emit("gameSession", GAME_SESSION);
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);

    socket.emit("playerList", game.players);
    socket.emit("lockedCharacters", Array.from(lockedCharacters));

    console.log("A player connected:", socket.id);

    // JOIN LOBBY
    socket.on("join", ({ playerId, name, character }) => {
        if (socket.data.joined) return;
        socket.data.joined = true;

        console.log("JOIN ATTEMPT:", { playerId, name, character });
        const normalized = character.toLowerCase();

        let existingPlayer = game.players.find(p => p.playerId === playerId);

        // RECONNECT (even if marked disconnected)
        const RECONNECT_WINDOW = 10000;

        if (existingPlayer) {
            const withinWindow =
                !existingPlayer.disconnectTime ||
                Date.now() - existingPlayer.disconnectTime < RECONNECT_WINDOW;

            if (withinWindow) {
                existingPlayer.id = socket.id;
                existingPlayer.disconnected = false;
                existingPlayer.disconnectTime = null;

                // CANCEL OLD DELETE TIMER
                const timer = disconnectTimers.get(playerId);
                if (timer) {
                    clearTimeout(timer);
                    disconnectTimers.delete(playerId);
                }

                console.log(name + " reconnected and reclaimed slot");

                io.emit("playerList", game.players);
                io.emit("lockedCharacters", Array.from(lockedCharacters));

                socket.emit("joinSuccess");
                return;
            }
        }

        if (existingPlayer && existingPlayer.disconnected) {
            // expired reconnect window treat as new join
            lockedCharacters.delete(existingPlayer.character.toLowerCase());

            game.players = game.players.filter(p => p.playerId !== playerId);
        }

        // CHARACTER TAKEN
        const characterOwnedBySomeoneElse = game.players.find(
            p => p.character.toLowerCase() === normalized && p.playerId !== playerId
        );

        if (characterOwnedBySomeoneElse) {
            socket.emit("characterTaken");
            return;
        }

        if (lockedCharacters.has(normalized)) {
            socket.emit("characterTaken");
            return;
        }

        // VALID JOIN
        lockedCharacters.add(normalized);

        game.players.push({
            id: socket.id,
            playerId,
            name,
            character,
            disconnected: false,
            disconnectTime: null
        });

        console.log(name + " joined with " + character);

        io.emit("playerList", game.players);
        io.emit("lockedCharacters", Array.from(lockedCharacters));

        socket.emit("joinSuccess");

        broadcastToUnity({
            type: "playerList",
            players: game.players.map(p => ({
                id: p.id,
                name: p.name,
                characterId: p.character.toLowerCase()
            }))
        });
    });

    // START GAME
    socket.on("startGame", () => {
        game.state = "playing";

        generateBoard();

        io.emit("gameStarted", game.board);
    });

    // SELECT CLUE
    socket.on("selectClue", (data) => {
        io.emit("clueSelected", data);
    });

    // SUBMIT ANSWER
    socket.on("submitAnswer", (data) => {
        io.emit("answerSubmitted", data);
    });

    // DISCONNECT
    socket.on("disconnect", () => {
        const player = game.players.find(p => p.id === socket.id);

        if (!player) return;

        console.log(player.name + " temporarily disconnected");

        player.disconnected = true;
        player.disconnectTime = Date.now();

        const timer = setTimeout(() => {
            const p = game.players.find(p => p.playerId === player.playerId);

            // IMPORTANT: only remove if STILL disconnected AND no reconnection happened
            if (!p || !p.disconnected) return;

            console.log(player.name + " fully removed");

            lockedCharacters.delete(player.character.toLowerCase());

            game.players = game.players.filter(p => p.playerId !== player.playerId);

            io.emit("playerList", game.players);
            io.emit("lockedCharacters", Array.from(lockedCharacters));

            disconnectTimers.delete(player.playerId);
        }, 5000);

        disconnectTimers.set(player.playerId, timer);
    });
});

resetGameState();
console.log("NEW SERVER SESSION:", GAME_SESSION);

// START SERVER
http.listen(PORT, "0.0.0.0", () => {
    console.log("================================");
    console.log("PA Jeopardy SERVER LIVE");
    console.log("Port:", PORT);
    console.log("Session:", GAME_SESSION);
    console.log("================================");
});
