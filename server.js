const express = require("express");
const app = express();
const http = require("http").createServer(app);
const loadCategories = require("./loadCategories");

app.use("/characters", express.static("characters"));
app.use("/fonts", express.static("fonts"));
app.use("/backgrounds", express.static("backgrounds"));
app.use("/sprites", express.static("sprites"));
app.use("/confetti", express.static("public/confetti"));

let hostConnected = false;
let GAME_SESSION = Date.now();
const disconnectTimers = new Map();
const joinCooldown = new Map();
const JOIN_COOLDOWN_MS = 2000;
const usedClueIds = new Set();
const lockedCharacters = new Set();

// BRIDGE FROM SOCKET.IO TO WEBSOCKET
const WebSocket = require("ws");
const wss = new WebSocket.Server({
    server: http,
    path: "/unity"
});

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

// WEBSOCKET TO UNITY
function broadcastToUnity(data) {
    const message = JSON.stringify(data);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastSession() {
    io.emit("gameSession", {
        type: "gameSession",
        session: GAME_SESSION
    });

    broadcastToUnity({
        type: "gameSession",
        session: GAME_SESSION
    });
}

// GENERATE BOARD
function generateBoard() {

    const allCategories = loadCategories();

    // RANDOMIZE CATEGORY ORDER
    const shuffled = allCategories.sort(() => Math.random() - 0.5);

    // PICK 6 CATEGORIES
    const selectedCategories = shuffled.slice(0, 6);

    game.board = {};

    selectedCategories.forEach(categoryData => {

        const categoryName = categoryData.category;

        game.board[categoryName] = {};

        for (const value in categoryData.clues) {

            const options = categoryData.clues[value];

            // REMOVE USED CLUES
            const available = options.filter(
                clue => !usedClueIds.has(clue.id)
            );

            if (available.length === 0) {
                console.log("No clues left for:", categoryName, value);
                continue;
            }

            // PICK RANDOM CLUE
            const chosen =
                available[Math.floor(Math.random() * available.length)];

            // MARK GLOBALLY USED
            usedClueIds.add(chosen.id);

            game.board[categoryName][value] = {
                id: chosen.id,
                clue: chosen.clue,
                answer: chosen.answer,
                used: false
            };
        }
    });

    console.log("Generated board:");
    console.log(game.board);
}

function resetGameState() {
    game.players = [];
    game.state = "lobby";
    game.board = {};
    lockedCharacters.clear();

    broadcastSession();
    GAME_SESSION = Date.now();
}

// ROOM CODE
const ROOM_CODE = "PA26";
console.log("Room code for players to join:", ROOM_CODE);

// WEBPAGE
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// FLATTEN BOARD FOR UNITY
function convertBoardForUnity(board) {
    const categories = [];

    for (const categoryName in board) {

        const category = {
            categoryName,
            clues: []
        };

        for (const value in board[categoryName]) {

            category.clues.push({
                value,
                clueData: board[categoryName][value]
            });
        }

        categories.push(category);
    }

    return { categories };
}

// NEW CONNECTION
io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);
    socket.data.joined = false;
    socket.isUnity = false;
    // SEND INFO TO WEB
    broadcastSession();
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("hostStatus", hostConnected);

    socket.emit("playerList", game.players);
    socket.emit("lockedCharacters", Array.from(lockedCharacters));

    console.log("A player connected:", socket.id);

    // JOIN LOBBY
    socket.on("join", ({ playerId, name, character, isHost }) => {
        const now = Date.now();
        const lastJoin = joinCooldown.get(socket.id) || 0;

        if (existingPlayer && existingPlayer.socketId !== socket.id) {
            console.log("Old socket, ignoring join");
            return;
        }

        // anti-spam join protection
        if (now - lastJoin < JOIN_COOLDOWN_MS) {
            console.log("Join blocked (spam):", socket.id);
            return;
        }

        joinCooldown.set(socket.id, now);

        // ---------------- HOST LOGIC ----------------
        if (isHost) {
            if (hostConnected) {
                socket.emit("hostTaken");
                return;
            }

            hostConnected = true;
            socket.isHost = true;

            io.emit("hostStatus", true);

            socket.emit("joinSuccess");

            socket.emit("gameStateSync", {
                state: game.state,
                players: game.players,
                board: game.board
            });

            console.log("Host connected");
            broadcastSession();

            return;
        }

        // ---------------- PLAYER JOIN ----------------
        console.log("JOIN ATTEMPT:", { playerId, name, character });

        const normalized = character.toLowerCase();

        // find existing player
        let existingPlayer = game.players.find(p => p.playerId === playerId);

        // ---------------- SESSION DESYNC PROTECTION ----------------
        if (existingPlayer) {
            const sessionMismatch =
                existingPlayer.session !== GAME_SESSION;

            if (sessionMismatch) {
                console.log("Session mismatch - forcing fresh join");

                game.players = game.players.filter(p => p.playerId !== playerId);
                existingPlayer = null;
            }
        }

        // ---------------- RECONNECT LOGIC ----------------
        const RECONNECT_WINDOW = 10000;

        if (existingPlayer) {
            const stillValid =
                !existingPlayer.disconnectTime ||
                Date.now() - existingPlayer.disconnectTime < RECONNECT_WINDOW;

            if (stillValid) {
                existingPlayer.socketId = socket.id;
                existingPlayer.disconnected = false;
                existingPlayer.disconnectTime = null;
                existingPlayer.session = GAME_SESSION;

                // cancel pending removal
                const timer = disconnectTimers.get(playerId);
                if (timer) {
                    clearTimeout(timer);
                    disconnectTimers.delete(playerId);
                }

                console.log(name + " reconnected with " + character);

                io.emit("playerList", game.players.map(p => ({
                    playerId: p.playerId,
                    name: p.name,
                    character: p.character,
                    disconnected: p.disconnected
                })));

                io.emit("lockedCharacters", Array.from(lockedCharacters));

                socket.emit("joinSuccess");

                socket.emit("gameStateSync", {
                    state: game.state,
                    players: game.players,
                    board: game.board
                });

                broadcastSession();

                return;
            }
        }

        // ---------------- CLEANUP OLD DISCONNECTED ENTRY ----------------
        if (existingPlayer && existingPlayer.disconnected) {
            lockedCharacters.delete(existingPlayer.characterKey);

            game.players = game.players.filter(p => p.playerId !== playerId);
        }

        // ---------------- CHARACTER VALIDATION ----------------
        const characterOwnedBySomeoneElse = game.players.find(
            p => p.character.toLowerCase() === normalized &&
                 p.playerId !== playerId
        );

        if (characterOwnedBySomeoneElse) {
            socket.emit("characterTaken");
            return;
        }

        if (lockedCharacters.has(normalized)) {
            socket.emit("characterTaken");
            return;
        }

        // ---------------- NEW PLAYER JOIN ----------------
        lockedCharacters.add(normalized);

        game.players.push({
            socketId: socket.id,
            playerId,
            name,
            character,
            characterKey: normalized,
            isHost: false,
            disconnected: false,
            disconnectTime: null,
            session: GAME_SESSION
        });

        console.log(name + " joined with " + character);

        // ---------------- BROADCAST UPDATES ----------------
        io.emit("playerList", game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            disconnected: p.disconnected
        })));

        io.emit("lockedCharacters", Array.from(lockedCharacters));

        socket.emit("joinSuccess");

        socket.emit("gameStateSync", {
            state: game.state,
            players: game.players,
            board: game.board
        });

        broadcastToUnity({
            type: "playerList",
            players: game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                characterId: p.characterKey
            }))
        });

        broadcastSession();
    });

    // HOST CONTROLS
    socket.on("hostAction", (data) => {
        // ONLY ALLOW HOST SOCKET
        if (!socket.isHost) return;

        console.log("HOST ACTION:", data);

        // SEND TO UNITY
        if (data.type === "startGame") {
            generateBoard();

            GAME_SESSION = Date.now(); // IMPORTANT

            broadcastSession();

            // FIRST tell Unity to load lobby scene
            broadcastToUnity({
                type: "startGame"
            });

            // THEN send board data
            setTimeout(() => {

                broadcastToUnity({
                    type: "boardData",
                    board: convertBoardForUnity(game.board)
                });
                io.emit("boardData", convertBoardForUnity(game.board));

            }, 1000);
        }
        else {

            broadcastToUnity({
                type: data.type,
                payload: data.payload || null
            });
        }

        // OPTIONAL WEB EVENTS
        switch (data.type) {

            case "showInstructions":
                io.emit("showInstructions");
                break;

            case "showBoard":
                io.emit("showBoard");
                break;

            case "selectClue":
                io.emit("selectClue", data.payload);

                broadcastToUnity({
                    type: "selectClue",
                    payload: data.payload
                });
                break;

            case "revealAnswer":
                io.emit("revealAnswer");
                break;

            case "resumeBuzzing":
                io.emit("resumeBuzzing");
                break;
        }
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
        joinCooldown.delete(socket.id);

        if (socket.isHost) {
            hostConnected = false;
            io.emit("hostStatus", false);
            console.log("Host disconnected");
        }

        const player = game.players.find(p => p.socketId === socket.id);
        if (!player) return;
        if (player.socketId !== socket.id) return;
        console.log(player.name + " temporarily disconnected");

        player.disconnected = true;
        player.disconnectTime = Date.now();

        const timer = setTimeout(() => {

            const stillThere = game.players.find(p => p.playerId === player.playerId);

            if (!stillThere || stillThere.socketId === socket.id) {
                disconnectTimers.delete(player.playerId);
                return;
            }

            console.log(player.name + " fully removed");

            lockedCharacters.delete(player.characterKey);

            game.players = game.players.filter(
                p => p.playerId !== player.playerId
            );

            io.emit("playerList", game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                character: p.character,
                disconnected: p.disconnected
            })));
            io.emit("lockedCharacters", Array.from(lockedCharacters));

            disconnectTimers.delete(player.playerId);

        }, 10000);

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