const express = require("express");
const app = express();
const http = require("http").createServer(app);
const loadCategories = require("./loadCategories");

app.use("/characters", express.static("characters"));
app.use("/fonts", express.static("fonts"));
app.use("/backgrounds", express.static("backgrounds"));
app.use("/sprites", express.static("sprites"));
app.use("/confetti", express.static("public/confetti"));

// HOST NOT CONNECTED
let hostConnected = false;
// CURRENT SESSION
let GAME_SESSION = Date.now();
// DISCONNECT TIMER
const disconnectTimers = new Map();
// USED CLUES
const usedClueIds = new Set();
// LOCKED CHARACTERS
const lockedCharacters = new Set();
// BUZZER
let buzzAccepted = false;
let currentBuzzPlayer = null;
//SCORE
let currentClueValue = 0;

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
    //{ name: "Wise Old Boy", front: "/characters/oldsawyerfront.png", back: "/characters/oldsawyerback.png" },
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
                value,
                category: categoryName,
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
    socket.emit("gameSession", GAME_SESSION);
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("hostStatus", hostConnected);

    socket.emit("playerList", game.players);
    socket.emit("lockedCharacters", Array.from(lockedCharacters));

    console.log("A player connected:", socket.id);

    // JOIN LOBBY
    socket.on("join", ({ playerId, name, character, isHost }) => {
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

            return;
        }

        console.log("JOIN ATTEMPT:", { playerId, name, character });
        const normalized = character.toLowerCase();

        let existingPlayer = game.players.find(p => p.playerId === playerId);

        const RECONNECT_WINDOW = 10000;

        if (existingPlayer && existingPlayer.disconnected) {
            existingPlayer.socketId = socket.id;
            existingPlayer.disconnected = false;
            existingPlayer.disconnectTime = null;

            console.log(name + " reconnected");

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
                board: game.board,
                lockedCharacters: Array.from(lockedCharacters)
            });
            socket.data.joined = true;
            return;
        }

        if (existingPlayer && existingPlayer.disconnected) {
            lockedCharacters.delete(existingPlayer.characterKey);

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
            socketId: socket.id,
            playerId,
            name,
            character,
            characterKey: character.toLowerCase(),
            score: 0,
            isHost: !!isHost,
            disconnected: false,
            disconnectTime: null
        });

        socket.data.joined = true;

        console.log(name + " joined with " + character);

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
    });

    // HOST CONTROLS
    socket.on("hostAction", (data) => {
        // ONLY ALLOW HOST SOCKET
        if (!socket.isHost) return;

        console.log("HOST ACTION:", data);

        // SEND TO UNITY
        if (data.type === "startGame") {
            generateBoard();

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

            case "showInstrucCutscene":
                io.emit("showInstrucCutscene");
                break;

            case "showBoardIntro":
                io.emit("showBoardIntro");
                break;

            case "selectClue": {
                const clue = data.payload?.clueData;
                currentClueValue = parseInt(data.payload.value);

                if (!clue || !clue.id) return;

                const clueId = clue.id;

                if (usedClueIds.has(clueId)) return;

                usedClueIds.add(clueId);

                buzzAccepted = false;

                const payload = {
                    type: "selectClue",
                    payload: {
                        value: data.payload.value,
                        clueId: clueId,
                        clueData: clue,
                        used: true
                    }
                };

                // SEND SAME STRUCTURE TO BOTH
                const message = JSON.stringify(payload);

                io.emit("selectClue", payload);
                broadcastToUnity(payload);

                break;
            }

            case "answerCorrect":
                if (currentBuzzPlayer) {

                    currentBuzzPlayer.score += currentClueValue;

                    io.emit("scoreUpdate", {
                        playerId: currentBuzzPlayer.playerId,
                        score: currentBuzzPlayer.score,
                        earned: currentClueValue
                    });

                    broadcastToUnity({
                        type: "scoreUpdate",
                        playerId: currentBuzzPlayer.playerId,
                        score: currentBuzzPlayer.score
                    });
                }

                io.emit("showScoreScreen");

                broadcastToUnity({
                    type: "showScoreScreen"
                });

                break;

            case "continueClue":
                io.emit("showScoreScreen");

                broadcastToUnity({
                    type: "showScoreScreen"
                });

                break;

            case "revealAnswer":
                console.log("REVEAL ANSWER - Server");
                io.emit("revealAnswer");

                broadcastToUnity({
                    type: "revealAnswer"
                });
                break;

            case "resumeBuzzing":
                buzzAccepted = true;
                currentBuzzPlayer = null;

                io.emit("resumeBuzzing");
                break;
        }
    });

    // BUZZER SCREEN
    socket.on("buzz", () => {
        if (!buzzAccepted)
            return;

        buzzAccepted = false;

        const player = game.players.find(
            p => p.socketId === socket.id
        );

        if (!player)
            return;

        currentBuzzPlayer = player;

        io.emit("buzzAccepted", {
            playerId: player.playerId,
            playerName: player.name,
            character: player.character
        });

        broadcastToUnity({
            type: "buzzAccepted",
            playerName: player.name
        });

        console.log("Buzz won by", player.name);
    });

    // START GAME
    socket.on("startGame", () => {
        game.state = "playing";

        generateBoard();

        io.emit("gameStarted", game.board);
    });

    // DISCONNECT
    socket.on("disconnect", () => {
        if (socket.isHost) {
            hostConnected = false;
            io.emit("hostStatus", false);
            console.log("Host disconnected");
        }

        const player = game.players.find(p => p.socketId === socket.id);
        if (!player) return;

        console.log(player.name + " temporarily disconnected");

        player.disconnected = true;
        player.disconnectTime = Date.now();

        io.emit("playerList", game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            disconnected: p.disconnected
        })));

        //disconnectTimers.set(player.playerId, timer);
    });

    socket.on("leavePlayer", ({ playerId }) => {
        const player = game.players.find(
            p => p.playerId === playerId
        );

        if (!player) return;

        console.log(player.name + " left character selection");

        lockedCharacters.delete(player.characterKey);

        game.players = game.players.filter(
            p => p.playerId !== playerId
        );

        io.emit("playerList", game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            disconnected: p.disconnected
        })));

        io.emit("lockedCharacters", Array.from(lockedCharacters));

        broadcastToUnity({
            type: "playerList",
            players: game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                characterId: p.characterKey
            }))
        });
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
