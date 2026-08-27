const express = require("express");
const app = express();
const http = require("http").createServer(app);
const loadCategories = require("./loadCategories");

app.use(express.static("public"));
app.use("/characters", express.static("characters"));
app.use("/fonts", express.static("fonts"));
app.use("/backgrounds", express.static("backgrounds"));
app.use("/sprites", express.static("sprites"));
app.use("/confetti", express.static("public/confetti"));
app.use("/clueImages", express.static("clueImages"));
app.use("/answerImages", express.static("answerImages"));
app.use("/data/clueImages", express.static("clueImages"));
app.use("/data/answerImages", express.static("answerImages"));

// HOST CONNECTION
let hostConnected = false;
let hostSocketId = null;

const HOST_RECONNECT_TOKEN = "HOST_" + Math.random().toString(36).substring(2) + "_" + Date.now();

let hostDisconnectTimer = null;
const HOST_RECONNECT_WINDOW = 300000;

// CURRENT GAME SESSION
let GAME_SESSION = Date.now();

console.log("NEW SERVER SESSION:", GAME_SESSION);
console.log("================================");
console.log("PA Jeopardy SERVER LIVE");
console.log("Port:", process.env.PORT || 3000);
console.log("Session:", GAME_SESSION);
console.log("================================");

const disconnectTimers = new Map();
//const round1Categories = new Set();
const lockedCharacters = new Set();
const usedCategoryNames = new Set();

let buzzAccepted = false;
let currentBuzzPlayer = null;
let buzzedPlayerIds = new Set();

let currentDailyDoubleWager=0;
let currentDailyDoublePlayer=null;
let currentDailyDoubleWagerSubmitted=false;

let answerTimer = null;

const ANSWER_TIME_SECONDS = 12;
const ANSWER_TIME_MS = ANSWER_TIME_SECONDS * 1000;

// Gives Unity a fraction of a second to visibly finish
// before the server changes the game state.
const ANSWER_TIMER_GRACE_MS = 600;

// BRIDGE FROM SOCKET.IO TO WEBSOCKET
const WebSocket = require("ws");
const wss = new WebSocket.Server({
    server: http,
    path: "/unity"
});

wss.on("connection", (ws) => {
    ws.isUnity = true;
    ws.isAlive = true;

    console.log("================================");
    console.log("UNITY WEBSOCKET CONNECTED");
    console.log("================================");

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("error", (error) => {
        console.error(
            "UNITY WEBSOCKET ERROR:",
            error
        );
    });

    ws.on("close", (code, reason) => {

        console.log(
            "UNITY WEBSOCKET CLOSED:",
            code,
            reason?.toString()
        );

    });
});

const unityHeartbeat = setInterval(() => {

    wss.clients.forEach(ws => {

        if (ws.isAlive === false) {

            console.log(
                "Terminating dead Unity WebSocket"
            );

            return ws.terminate();
        }

        ws.isAlive = false;

        ws.ping();
    });

}, 30000);

const io = require("socket.io")(http, {
    cors: {
        origin: "*"
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 60000,
    connectTimeout: 20000
});

// CLOUD SERVER
const PORT = process.env.PORT || 3000;

// MAIN GAME STATE
const game = {
    players: [],
    state: "lobby",
    round: 0,
    board: {},
    usedClueIds: new Set(),
    dailyDoubleIds: new Set(),
    currentClueId: null,
    currentClueValue: 0,
    currentClueIsDailyDouble: false,
    hostScreen: "hostJoinPg",

    finalJeopardy: {
        category: "",
        clueId: "",
        clue: "",
        clueImage: "",
        answer: "",
        answerImage: "",
        wagers: {},
        answers: {},
        wagerSubmitted: {},
        answerSubmitted: {},
        judged: {}
    }
};

// CHARACTER STORAGE
const characters = [
    {
        name: "The Boss",
        front: "/characters/thebossfront.png",
        back: "/characters/thebossback.png"
    },
    {
        name: "Janice Mowes",
        front: "/characters/janicemowesfront.png",
        back: "/characters/janicemowesback.png"
    },
    {
        name: "Tricerex",
        front: "/characters/tricerexfront.png",
        back: "/characters/tricerexback.png"
    },
    {
        name: "Fancy Dancer",
        front: "/characters/fancydancerpinkfront.png",
        back: "/characters/fancydancerpinkback.png"
    },
    {
        name: "Deerhead",
        front: "/characters/deerheadfront.png",
        back: "/characters/deerheadback.png"
    },
    {
        name: "Caity Satyr",
        front: "/characters/caitysatyrfront.png",
        back: "/characters/caitysatyrback.png"
    },
    {
        name: "The Holy Spirit",
        front: "/characters/jesusfront.png",
        back: "/characters/jesusback.png"
    },
    {
        name: "The Newlyweds",
        front: "/characters/thenewlywedsfront.png",
        back: "/characters/thenewlywedsback.png"
    },
    {
        name: "Lorenzo",
        front: "/characters/lorenzofront.png",
        back: "/characters/lorenzoback.png"
    },
    {
        name: "The Guitarist",
        front: "/characters/theguitaristfront.png",
        back: "/characters/theguitaristback.png"
    }
];

function getScorePlayers() {
    return game.players.map(player => ({
        playerId: player.playerId,
        name: player.name,
        character: player.character,
        score: player.score || 0
    }));
}

function setPlayerScreen(player, screen) {
    if (!player) return;
    player.screen = screen;
    console.log("PLAYER SCREEN:", player.name, "->", screen);
}

function setAllPlayerScreens(screen) {
    game.players.forEach(player => {
        setPlayerScreen(player, screen);
    });
}

// WEBSOCKET TO UNITY
function broadcastToUnity(data) {
    const message = JSON.stringify(data);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastPlayerScores(){
    game.players.forEach(player=>{
        io.to(player.socketId).emit("scoreUpdate",{
            score:player.score||0
        });
    });
}

// GENERATE BOARD
function generateBoard(roundNumber) {
    console.log("================================");
    console.log("GENERATING ROUND", roundNumber);
    console.log("================================");

    const allCategories = loadCategories();

    // Clear the previous round's board before building this one.
    game.board = {};
    game.dailyDoubleIds = new Set();

    // Only categories that have NOT been used in a previous round
    const availableCategories = allCategories.filter(categoryData => {
        return !usedCategoryNames.has(categoryData.category);
    });

    console.log(
        "AVAILABLE CATEGORIES FOR ROUND",
        roundNumber,
        ":",
        availableCategories.map(c => c.category)
    );

    if (availableCategories.length < 6) {
        console.error(
            "NOT ENOUGH UNUSED CATEGORIES FOR ROUND",
            roundNumber,
            "Available:",
            availableCategories.length
        );
        return;
    }

    // Randomize remaining categories
    const shuffled = [...availableCategories].sort(
        () => Math.random() - 0.5
    );

    // Pick 6 completely unused categories
    const selectedCategories = shuffled.slice(0, 6);

    selectedCategories.forEach(categoryData => {
        usedCategoryNames.add(categoryData.category);
    });

    console.log(
        "SELECTED CATEGORIES FOR ROUND",
        roundNumber,
        ":",
        selectedCategories.map(c => c.category)
    );

    const sourceValues = ["200", "400", "600", "800", "1000"];
    const displayValues = roundNumber === 1 ? ["200", "400", "600", "800", "1000"] : ["400", "800", "1200", "1600", "2000"];

    selectedCategories.forEach(categoryData => {
        const categoryName = categoryData.category;
        game.board[categoryName] = {};

        sourceValues.forEach((sourceValue, index) => {
            const displayValue = displayValues[index];
            const options = categoryData.clues[sourceValue];

            if (!options || options.length === 0) {
                console.warn("NO CLUES FOUND:", categoryName, "SOURCE VALUE:", sourceValue);
                return;
            }

            const available = options.filter(clue => !game.usedClueIds.has(clue.id));

            if (available.length === 0) {
                console.warn("NO UNUSED CLUES:", categoryName, "SOURCE VALUE:", sourceValue);
                return;
            }

            const chosen = available[Math.floor(Math.random() * available.length)];

            game.board[categoryName][displayValue] = {
                id: chosen.id,
                value: displayValue,
                sourceValue: sourceValue,
                category: categoryName,
                clue: chosen.clue,
                clueImage: chosen.clueImage || "",
                answer: chosen.answer,
                answerImage: chosen.answerImage || "",
                used: false,
                dailyDouble: false
            };

            console.log("BOARD SLOT:", categoryName, "JSON:", sourceValue, "DISPLAY:", displayValue, "CLUE:", chosen.id);
        });
    });

    // DAILY DOUBLES
    const allTiles = [];

    for (const categoryName in game.board) {
        for (const value in game.board[categoryName]) {
            allTiles.push(game.board[categoryName][value]);
        }
    }

    // Round 1 = 1 Daily Double
    // Round 2 = 2 Daily Doubles
    const dailyDoubleCount = roundNumber === 1 ? 1 : 2;

    allTiles.sort(() => Math.random() - 0.5);

    for (
        let i = 0;
        i < Math.min(dailyDoubleCount, allTiles.length);
        i++
    ) {
        const clue = allTiles[i];

        clue.dailyDouble = true;
        game.dailyDoubleIds.add(clue.id);

        console.log(
            "DAILY DOUBLE:",
            clue.category,
            clue.value,
            clue.id
        );
    }

    console.log("================================");
    console.log("ROUND", roundNumber, "BOARD GENERATED");
    console.log("Categories:", Object.keys(game.board));
    console.log(
        "Daily Doubles:",
        game.dailyDoubleIds.size
    );

    for (const categoryName in game.board) {
        console.log(
            "CATEGORY:",
            categoryName,
            "VALUES:",
            Object.keys(game.board[categoryName])
        );
    }

    console.log("================================");
}

function clearAnswerTimer() {
    if (answerTimer) {
        clearTimeout(answerTimer);
        answerTimer = null;
    }
}

function generateFinalJeopardy() {
    console.log("================================");
    console.log("GENERATING FINAL JEOPARDY");
    console.log("================================");

    const allCategories = loadCategories();

    // Final Jeopardy must come from a category that was never
    // used in Round 1 or Round 2.
    const unusedCategories = allCategories.filter(categoryData => {
        return !usedCategoryNames.has(categoryData.category);
    });

    console.log(
        "UNUSED CATEGORIES AVAILABLE FOR FINAL:",
        unusedCategories.map(c => c.category)
    );

    if (unusedCategories.length === 0) {
        console.error("NO UNUSED CATEGORY AVAILABLE FOR FINAL JEOPARDY.");
        return false;
    }

    // Only categories with at least one usable $1000 clue.
    const eligibleCategories = unusedCategories.filter(categoryData => {
        const options = categoryData.clues?.["1000"];

        if (!Array.isArray(options) || options.length === 0) {
            return false;
        }

        return options.some(clue => {
            return clue?.id && !game.usedClueIds.has(clue.id);
        });
    });

    if (eligibleCategories.length === 0) {
        console.error("NO UNUSED CATEGORY HAS AN AVAILABLE $1000 CLUE.");
        return false;
    }

    const categoryData =
        eligibleCategories[
            Math.floor(Math.random() * eligibleCategories.length)
        ];

    const availableClues =
        categoryData.clues["1000"].filter(clue => {
            return clue?.id && !game.usedClueIds.has(clue.id);
        });

    const chosen =
        availableClues[
            Math.floor(Math.random() * availableClues.length)
        ];

    game.finalJeopardy = {
        category: categoryData.category,
        clueId: chosen.id,
        clue: chosen.clue,
        clueImage: chosen.clueImage || "",
        answer: chosen.answer,
        answerImage: chosen.answerImage || "",
        wagers: {},
        answers: {},
        wagerSubmitted: {},
        answerSubmitted: {},
        judged: {}
    };

    // Reserve the clue so nothing else can ever use it.
    game.usedClueIds.add(chosen.id);

    console.log("FINAL JEOPARDY CATEGORY:", game.finalJeopardy.category);
    console.log("FINAL JEOPARDY CLUE ID:", game.finalJeopardy.clueId);
    console.log("FINAL JEOPARDY SOURCE VALUE: 1000");
    console.log("================================");

    return true;
}

function resetGameState() {
    game.players = [];
    game.state = "lobby";
    game.round = 0;
    game.board = {};
    game.usedClueIds.clear();
    game.dailyDoubleIds.clear();
    usedCategoryNames.clear();
    game.currentClueId = null;
    game.currentClueValue = 0;
    game.currentClueIsDailyDouble = false;
    game.hostScreen = "hostJoinPg";
    lockedCharacters.clear();
    buzzAccepted = false;
    currentBuzzPlayer = null;
    GAME_SESSION = Date.now();
    console.log("GAME STATE RESET");
    console.log("NEW GAME SESSION:", GAME_SESSION);

    game.finalJeopardy = {
        category: "",
        clueId: "",
        clue: "",
        clueImage: "",
        answer: "",
        answerImage: "",
        wagers: {},
        answers: {},
        wagerSubmitted: {},
        answerSubmitted: {},
        judged: {}
    };
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

function getPublicGameState() {
    return {
        state: game.state,
        round: game.round,
        board: convertBoardForUnity(game.board),
        currentClueId: game.currentClueId,
        currentClueValue: game.currentClueValue,
        currentClueIsDailyDouble:
            game.currentClueIsDailyDouble,

        players: game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            score: p.score,
            disconnected: p.disconnected
        }))
    };
}

function sendHostState(socket) {
    socket.emit("hostStatus", true);
    socket.emit("gameSession", GAME_SESSION);
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("playerList", game.players.map(p => ({
        playerId: p.playerId,
        name: p.name,
        character: p.character,
        score: p.score || 0,
        disconnected: p.disconnected
    })));
    socket.emit("lockedCharacters", Array.from(lockedCharacters));
    socket.emit("gameStateSync", {
        role: "host",
        state: game.state,
        round: game.round,
        players: game.players,
        board: convertBoardForUnity(game.board),
        lockedCharacters: Array.from(lockedCharacters),
        currentClueId: game.currentClueId,
        currentClueValue: game.currentClueValue,
        currentClueIsDailyDouble: game.currentClueIsDailyDouble,
        hostScreen: game.hostScreen || "hostJoinPg"
    });

    console.log("Host state synchronized:", {
        state: game.state,
        round: game.round,
        hostScreen: game.hostScreen,
        players: game.players.length
    });
}

function sendPlayerState(socket, player) {
    socket.emit("gameSession", GAME_SESSION);
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("lockedCharacters", Array.from(lockedCharacters));

    socket.emit("gameStateSync", {
        role: "player",
        state: game.state,
        round: game.round,
        players: getScorePlayers(),
        board: convertBoardForUnity(game.board),
        lockedCharacters: Array.from(lockedCharacters),
        currentClueId: game.currentClueId,
        currentClueValue: game.currentClueValue,
        currentClueIsDailyDouble: game.currentClueIsDailyDouble,
        playerScreen: player.screen || "waitingScreen",
        playerScore: player.score || 0,
        playerId: player.playerId
    });
}

// NEW CONNECTION
io.on("connection", (socket) => {
    console.log("================================");
    console.log("Socket connected:", socket.id);
    console.log("================================");

    socket.data.joined = false;
    socket.isHost = false;
    socket.emit("gameSession", GAME_SESSION);
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("hostStatus", hostConnected);
    socket.emit(
        "playerList",
        game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            disconnected: p.disconnected
        }))
    );
    socket.emit(
        "lockedCharacters",
        Array.from(lockedCharacters)
    );

    // AUTOMATIC HOST RECONNECTION
    const reconnectToken = socket.handshake.auth?.hostReconnectToken;

    if (reconnectToken && reconnectToken === HOST_RECONNECT_TOKEN) {
        console.log("HOST RECONNECT TOKEN ACCEPTED");

        hostConnected = true;
        hostSocketId = socket.id;
        socket.isHost = true;
        socket.data.joined = true;

        console.log("================================");
        console.log("HOST CONNECTED");
        console.log("Socket:", socket.id);
        console.log("================================");

        socket.emit("hostReconnectToken", HOST_RECONNECT_TOKEN);
        socket.emit("hostConfirmed");

        sendHostState(socket);
        io.emit("hostStatus", true);

        if (hostDisconnectTimer) {
            clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = null;
        }

        return;
    }
    console.log("A player connected:", socket.id);

    socket.on("resumeClient", data => {
        console.log("RESUME CLIENT:", data);

        if (!data || String(data.session) !== String(GAME_SESSION)) {
            socket.emit("resumeFailed", {
                reason: "sessionMismatch",
                session: GAME_SESSION
            });
            return;
        }

        if (data.role === "host") {
            if (!data.hostToken || data.hostToken !== HOST_RECONNECT_TOKEN) {
                socket.emit("resumeFailed", {
                    reason: "invalidHostToken"
                });
                return;
            }

            if (hostDisconnectTimer) {
                clearTimeout(hostDisconnectTimer);
                hostDisconnectTimer = null;
            }

            hostConnected = true;
            hostSocketId = socket.id;
            socket.isHost = true;
            socket.data.joined = true;

            console.log("HOST RESUMED:", socket.id);

            socket.emit("hostConfirmed");
            socket.emit("hostReconnectToken", HOST_RECONNECT_TOKEN);
            sendHostState(socket);
            io.emit("hostStatus", true);
            return;
        }

        if (data.role === "player") {
            const player = game.players.find(p => p.playerId === data.playerId);

            if (!player) {
                socket.emit("resumeFailed", {
                    reason: "playerNotFound"
                });
                return;
            }

            player.socketId = socket.id;
            player.disconnected = false;
            player.disconnectTime = null;

            socket.isHost = false;
            socket.data.joined = true;
            socket.data.playerId = player.playerId;

            console.log("PLAYER RESUMED:", player.name, socket.id);

            socket.emit("joinSuccess", {
                reconnect: true
            });

            sendPlayerState(socket, player);

            io.emit("playerList", game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                character: p.character,
                score: p.score || 0,
                disconnected: p.disconnected
            })));

            return;
        }

        socket.emit("resumeFailed", {
            reason: "unknownRole"
        });
    });

    // JOIN LOBBY
    socket.on("join", ({ playerId, name, character, isHost }) => {
        console.log("JOIN ATTEMPT:", {
            socketId: socket.id,
            playerId,
            name,
            character,
            isHost
        });

        // HOST JOIN
        if (isHost) {
            if (hostConnected) {
                console.log("HOST CONNECTION REJECTED - HOST ALREADY CONNECTED");
                socket.emit("hostTaken");
                return;
            }

            hostConnected = true;
            hostSocketId = socket.id;
            socket.isHost = true;
            socket.data.joined = true;

            console.log("NEW HOST CLAIMED:", socket.id);

            socket.emit("hostReconnectToken", HOST_RECONNECT_TOKEN);
            socket.emit("hostConfirmed");

            sendHostState(socket);
            io.emit("hostStatus", true);

            return;
        }

        // PLAYER JOIN
        if (!playerId || !name || !character) {
            console.warn(
                "Invalid player join attempt:",
                { playerId, name, character }
            );

            socket.emit("joinError", {
                message: "Missing player information."
            });

            return;
        }

        const normalized = character.toLowerCase();

        let existingPlayer = game.players.find(p => p.playerId === playerId);

        // CHARACTER TAKEN
        const characterOwnedBySomeoneElse =
            game.players.find(
                p =>
                    p.character.toLowerCase() === normalized &&
                    !p.disconnected
            );

        if (characterOwnedBySomeoneElse) {
            console.log(
                "Character already owned:",
                character
            );
            socket.emit("characterTaken");
            return;
        }

        if (lockedCharacters.has(normalized)) {
            console.log(
                "Character locked:",
                character
            );
            socket.emit("characterTaken");
            return;
        }

        lockedCharacters.add(normalized);

        const player = {
            socketId: socket.id,
            playerId,
            name,
            character,
            characterKey: normalized,
            score: 0,
            screen: "waitingScreen",
            isHost: false,
            disconnected: false,
            disconnectTime: null
        };

        game.players.push(player);
        socket.data.joined = true;
        console.log(name + " joined with " + character);

        // UPDATE WEB CLIENTS
        io.emit(
            "playerList",
            game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                character: p.character,
                disconnected: p.disconnected
            }))
        );

        io.emit(
            "lockedCharacters",
            Array.from(lockedCharacters)
        );

        socket.emit("joinSuccess");

        socket.emit("gameStateSync", {
            state: game.state,
            players: game.players,
            board: game.board,
            lockedCharacters: Array.from(lockedCharacters)
        });

        // UPDATE UNITY
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
        console.log("HOST ACTION RECEIVED:", data, "FROM:", socket.id, "IS HOST:", socket.isHost);
        if (!socket.isHost) {
            console.warn("HOST ACTION REJECTED - SOCKET IS NOT HOST:", socket.id);
            return;
        }
        console.log("HOST ACTION:", data);

        // HOST STATE ACTIONS
        if (data.type === "enableLobby") {
            console.log("HOST STARTING ROUND 1");
            game.state = "playing";
            game.round = 1;
            game.hostScreen = "hostLobbyPg";
            generateBoard(1);

            broadcastToUnity({ type: "enableLobby", round: game.round });
            io.emit("roundStarted", { round: game.round });

            setTimeout(() => {
                const boardData = {
                    round: game.round,
                    board: convertBoardForUnity(game.board)
                };
                broadcastToUnity({ type: "boardData", ...boardData });
                io.emit("boardData", boardData);
            }, 500);

            return;
        }

        if (data.type === "startRound2") {
            console.log("================================");
            console.log("STARTING ROUND 2");
            console.log("================================");

            game.round = 2;
            game.state = "playing";
            game.hostScreen = "hostBoard";

            game.currentClueId = null;
            game.currentClueValue = 0;
            game.currentClueIsDailyDouble = false;

            buzzAccepted = false;
            currentBuzzPlayer = null;
            buzzedPlayerIds.clear();

            currentDailyDoubleWager = 0;
            currentDailyDoublePlayer = null;
            currentDailyDoubleWagerSubmitted = false;

            // Generate Round 2 immediately.
            generateBoard(2);

            const round2BoardData = {
                round: 2,
                board: convertBoardForUnity(game.board)
            };

            // Phones return to their holding/score page.
            setAllPlayerScreens("scorePage");

            game.players.forEach(player => {
                io.to(player.socketId).emit(
                    "showScoreScreen",
                    {
                        players: getScorePlayers()
                    }
                );
            });

            // Unity immediately gets the new board.
            broadcastToUnity({
                type: "showRound2BoardIntro",
                round: 2,
                board: round2BoardData.board
            });

            // Host immediately gets the Round 2 board.
            io.emit(
                "showRound2Board",
                round2BoardData
            );

            io.emit(
                "boardData",
                round2BoardData
            );

            io.emit(
                "roundStarted",
                {
                    round: 2
                }
            );

            console.log(
                "ROUND 2 STARTED WITHOUT CUTSCENE"
            );

            return;
        }

        // OTHER HOST ACTIONS
        switch (data.type) {
            case "showInstructions":
                console.log("HOST ACTION: showInstructions");
                game.hostScreen = "hostInstructionsPg";
                game.state = "playing";

                setAllPlayerScreens("instructionsHoldingScreen");
                io.emit("showInstructionsHolding");
                broadcastToUnity({ type: "showInstructions" });
                break;
            /*
            case "showInstrucCutscene":
                console.log("HOST ACTION: showInstrucCutscene");

                game.hostScreen = "hostInstrucCutscenePg";

                broadcastToUnity({
                    type: "showInstrucCutscene"
                });

                break;
            */
            case "revealCategory": {
                const index = Number(data.payload?.index);

                if (!Number.isInteger(index) || index < 0 || index > 5) {
                    console.warn("Invalid category reveal index:", index);
                    return;
                }

                console.log("HOST REVEAL CATEGORY:", index);

                broadcastToUnity({
                    type: "revealCategory",
                    index: index
                });

                break;
            }

            case "showBoardIntro":
                console.log("HOST ACTION: showBoardIntro");
                game.hostScreen = "hostBoard";
                setAllPlayerScreens("scorePage");

                game.players.forEach(player => {
                    io.to(player.socketId).emit("showScoreScreen", {
                        players: getScorePlayers()
                    });
                });

                broadcastToUnity({
                    type: "showBoardIntro",
                    round: game.round,
                    board: convertBoardForUnity(game.board)
                });

                break;

            // SELECT CLUE
            case "selectClue": {
                console.log("HOST ACTION: selectClue");

                const clue = data.payload?.clueData;

                if (!clue || !clue.id) {
                    console.warn("selectClue received without valid clue data");
                    return;
                }

                const clueId = clue.id;

                // Prevent selecting the same clue twice
                if (game.usedClueIds.has(clueId)) {
                    console.warn("Clue already used:", clueId);
                    return;
                }

                game.usedClueIds.add(clueId);

                for (const categoryName in game.board) {
                    for (const value in game.board[categoryName]) {
                        const boardClue = game.board[categoryName][value];

                        if (boardClue.id === clueId) {
                            boardClue.used = true;
                            console.log("BOARD CLUE MARKED USED:", clueId);
                            break;
                        }
                    }
                }

                game.currentClueId = clueId;
                game.currentClueValue = parseInt(data.payload.value) || 0;
                game.currentClueIsDailyDouble = !!clue.dailyDouble;

                buzzAccepted = false;
                currentBuzzPlayer = null;
                buzzedPlayerIds.clear();

                currentDailyDoubleWager=0;
                currentDailyDoublePlayer=null;
                currentDailyDoubleWagerSubmitted=false;

                game.state =
                    game.currentClueIsDailyDouble
                        ? "dailyDouble"
                        : "buzzer";

                const payload = {
                    type: "selectClue",
                    round: game.round,
                    payload: {
                        value: data.payload.value,
                        clueId: clueId,
                        clueData: {
                            ...clue,
                            used: true,
                            dailyDouble: game.currentClueIsDailyDouble
                        }
                    }
                };

                io.emit(
                    "selectClue",
                    payload
                );

                broadcastToUnity(
                    payload
                );

                // ==========================================
                // DAILY DOUBLE
                // ==========================================

                if (game.currentClueIsDailyDouble) {
                    console.log("================================");
                    console.log("DAILY DOUBLE!");
                    console.log("Round:", game.round);
                    console.log("Clue:", clueId);
                    console.log("================================");

                    game.players.forEach(player=>{
                        io.to(player.socketId).emit("dailyDouble",{
                            round:game.round,
                            clueId,
                            value:game.currentClueValue,
                            clueData:clue
                        });
                    });

                    broadcastToUnity({
                        type: "dailyDouble",
                        round: game.round,
                        clueId,
                        value: game.currentClueValue
                    });
                }
                break;
            }

            // CORRECT ANSWER
            case "answerCorrect": {
                console.log("HOST ACTION: answerCorrect");

                clearAnswerTimer();

                if (!currentBuzzPlayer) {
                    console.warn("No player to award points to.");
                    return;
                }

                const earned = game.currentClueValue || 0;

                currentBuzzPlayer.score =
                    (currentBuzzPlayer.score || 0) + earned;

                console.log(
                    "ANSWER CORRECT:",
                    currentBuzzPlayer.name,
                    "earned:",
                    earned,
                    "new score:",
                    currentBuzzPlayer.score
                );

                io.emit("showScoreScreen", {
                    playerId: currentBuzzPlayer.playerId,
                    character: currentBuzzPlayer.character,
                    score: currentBuzzPlayer.score,
                    earned: earned,
                    players: getScorePlayers()
                });

                broadcastToUnity({
                    type: "showScoreScreen",
                    playerId: currentBuzzPlayer.playerId,
                    character: currentBuzzPlayer.character,
                    score: currentBuzzPlayer.score,
                    earned: earned
                });

                break;
            }

            // CONTINUE
            case "continueClue":
                console.log("HOST ACTION: continueClue");

                clearAnswerTimer();

                game.currentClueId = null;
                game.currentClueValue = 0;
                game.currentClueIsDailyDouble = false;

                buzzAccepted = false;
                currentBuzzPlayer = null;

                game.players.forEach(player => {
                    io.to(player.socketId).emit("showScoreScreen", {
                        players: getScorePlayers()
                    });
                });

                broadcastToUnity({
                    type: "showScoreScreen",
                    players: getScorePlayers()
                });

                break;

            // REVEAL ANSWER
            case "revealAnswer": {
                console.log("HOST ACTION: revealAnswer");

                clearAnswerTimer();

                buzzAccepted = false;

                io.emit("revealAnswer");

                broadcastToUnity({
                    type: "revealAnswer"
                });

                if (data.payload?.skipped === true) {
                    game.players.forEach(player => {
                        io.to(player.socketId).emit("showScoreScreen", {
                            players: getScorePlayers()
                        });
                    });
                }

                break;
            }

            // CLOSE CLUE
            case "closeClue":
                console.log("HOST ACTION: closeClue");
                setAllPlayerScreens("scorePage");
                clearAnswerTimer();
                game.currentClueId = null;
                game.currentClueValue = 0;
                game.currentClueIsDailyDouble = false;
                buzzAccepted = false;
                currentBuzzPlayer = null;
                buzzedPlayerIds.clear();
                currentDailyDoubleWager = 0;
                currentDailyDoublePlayer = null;
                currentDailyDoubleWagerSubmitted = false;

                broadcastToUnity({
                    type: "closeClue"
                });

                game.players.forEach(player => {
                    io.to(player.socketId).emit("closeClue");

                    io.to(player.socketId).emit("showScoreScreen", {
                        players: getScorePlayers()
                    });
                });

                break;

            // ENABLE / RESUME BUZZERS
            case "resumeBuzzing":
                console.log("HOST ACTION: resumeBuzzing");
                clearAnswerTimer();
                buzzAccepted = true;
                currentBuzzPlayer = null;

                game.players.forEach(player => {
                    // Anyone who has already attempted this clue
                    // cannot buzz again.
                    if (
                        buzzedPlayerIds.has(
                            player.playerId
                        )
                    ) {
                        console.log(
                            "NOT RE-ENABLING BUZZER FOR:",
                            player.name
                        );

                        setPlayerScreen(
                            player,
                            "scorePage"
                        );

                        io.to(player.socketId).emit(
                            "showScoreScreen",
                            {
                                players:
                                    getScorePlayers()
                            }
                        );

                        return;
                    }

                    console.log(
                        "RE-ENABLING BUZZER FOR:",
                        player.name
                    );

                    setPlayerScreen(
                        player,
                        "buzzerPage"
                    );

                    io.to(player.socketId).emit(
                        "resumeBuzzing"
                    );
                });

                broadcastToUnity({
                    type: "resumeBuzzing"
                });

                break;

            case "roundComplete": {
                console.log("ROUND", game.round, "COMPLETE");

                game.state = "roundComplete";

                const scorePlayers = getScorePlayers();

                io.emit("roundComplete", {
                    round: game.round,
                    players: scorePlayers
                });

                broadcastToUnity({
                    type: "roundComplete",
                    round: game.round,
                    players: scorePlayers
                });

                console.log("ROUND COMPLETE SCORES SENT TO UNITY:", scorePlayers);

                break;
            }

            case "startFinalJeopardy": {
                console.log("HOST ACTION: startFinalJeopardy");

                const generated =
                    generateFinalJeopardy();

                if (!generated) {
                    console.error(
                        "FINAL JEOPARDY COULD NOT BE GENERATED."
                    );
                    return;
                }

                game.state = "finalWager";
                game.round = 3;
                game.hostScreen = "hostFinalJeopardyPg";

                buzzAccepted = false;
                currentBuzzPlayer = null;
                buzzedPlayerIds.clear();

                // Everyone begins Final Jeopardy on the wager screen.
                game.players.forEach(player => {
                    setPlayerScreen(
                        player,
                        "finalJeopardyWagerScreen"
                    );

                    io.to(player.socketId).emit(
                        "finalJeopardyStart",
                        {
                            category:
                                game.finalJeopardy.category,

                            score:
                                player.score || 0
                        }
                    );
                });

                // Host sees category, but NOT the clue yet.
                if (hostSocketId) {
                    io.to(hostSocketId).emit(
                        "finalJeopardyStart",
                        {
                            category:
                                game.finalJeopardy.category,

                            players:
                                getScorePlayers()
                        }
                    );
                }

                // Unity gets only the category initially.
                broadcastToUnity({
                    type: "finalJeopardyStart",
                    category:
                        game.finalJeopardy.category
                });

                console.log(
                    "FINAL JEOPARDY STARTED:",
                    game.finalJeopardy.category
                );

                break;
            }

            case "revealFinalJeopardyClue": {
                console.log(
                    "HOST ACTION: revealFinalJeopardyClue"
                );

                game.state = "finalAnswering";

                // What player phones are allowed to receive.
                const publicClueData = {
                    category:
                        game.finalJeopardy.category,

                    clueId:
                        game.finalJeopardy.clueId,

                    clue:
                        game.finalJeopardy.clue,

                    clueImage:
                        game.finalJeopardy.clueImage
                };

                game.players.forEach(player => {
                    setPlayerScreen(
                        player,
                        "finalJeopardyAnswerScreen"
                    );

                    io.to(player.socketId).emit(
                        "finalJeopardyClue",
                        publicClueData
                    );
                });

                // Unity receives the answer as well,
                // because Unity will eventually reveal it.
                broadcastToUnity({
                    type: "finalJeopardyClue",

                    ...publicClueData,

                    answer:
                        game.finalJeopardy.answer,

                    answerImage:
                        game.finalJeopardy.answerImage
                });

                break;
            }

            // DAILY DOUBLE SELECT PLAYER
            case "dailyDoubleSelectPlayer": {
                console.log("HOST ACTION: dailyDoubleSelectPlayer");

                if (!game.currentClueIsDailyDouble) {
                    console.warn("Player selection attempted on non-Daily Double.");
                    return;
                }

                const playerId = data.playerId;
                const player = game.players.find(p => p.playerId === playerId);

                if (!player) {
                    console.warn("Daily Double player not found:", playerId);
                    return;
                }

                buzzAccepted = false;
                currentBuzzPlayer = player;

                currentDailyDoublePlayer = player;
                currentDailyDoubleWager = 0;
                currentDailyDoubleWagerSubmitted = false;

                setPlayerScreen(player, "dailyDoubleWagerScreen");

                game.players.forEach(otherPlayer => {
                    if (otherPlayer.playerId !== player.playerId) {
                        setPlayerScreen(otherPlayer, "answeringPage");
                    }
                });

                console.log("DAILY DOUBLE PLAYER:", player.name);

                io.to(player.socketId).emit("dailyDoubleAnswering", {
                    playerId: player.playerId,
                    playerName: player.name,
                    character: player.character,
                    score: player.score || 0,
                    clueValue: game.currentClueValue
                });

                game.players.forEach(otherPlayer => {
                    if (otherPlayer.playerId === player.playerId) return;

                    io.to(otherPlayer.socketId).emit("dailyDoubleWaiting", {
                        playerId: player.playerId,
                        playerName: player.name,
                        character: player.character
                    });
                });

                break;
            }

            case "dailyDoubleCorrect": {
                clearAnswerTimer();

                if (
                    !currentDailyDoublePlayer ||
                    !currentDailyDoubleWagerSubmitted
                ) {
                    console.warn("No submitted Daily Double wager to judge.");
                    return;
                }

                const wager = currentDailyDoubleWager;

                const oldScore =
                    currentDailyDoublePlayer.score || 0;

                currentDailyDoublePlayer.score =
                    oldScore + wager;

                console.log(
                    "DAILY DOUBLE CORRECT:",
                    currentDailyDoublePlayer.name,
                    "+", wager,
                    "OLD SCORE:", oldScore,
                    "NEW SCORE:", currentDailyDoublePlayer.score
                );

                // SCORE SCREEN
                io.emit("showScoreScreen", {
                    playerId: currentDailyDoublePlayer.playerId,
                    character: currentDailyDoublePlayer.character,
                    oldScore: oldScore,
                    score: currentDailyDoublePlayer.score,
                    earned: wager,
                    players: getScorePlayers()
                });

                broadcastToUnity({
                    type: "showScoreScreen",
                    playerId: currentDailyDoublePlayer.playerId,
                    character: currentDailyDoublePlayer.character,
                    oldScore: oldScore,
                    score: currentDailyDoublePlayer.score,
                    earned: wager
                });

                // Also update score state
                io.emit("scoreUpdate", {
                    playerId: currentDailyDoublePlayer.playerId,
                    playerName: currentDailyDoublePlayer.name,
                    score: currentDailyDoublePlayer.score
                });

                // Clear Daily Double state
                currentDailyDoublePlayer.dailyDoubleWager = 0;

                currentDailyDoubleWager = 0;
                currentDailyDoublePlayer = null;
                currentDailyDoubleWagerSubmitted = false;

                break;
            }

            case "dailyDoubleIncorrect": {
                clearAnswerTimer();

                if (
                    !currentDailyDoublePlayer ||
                    !currentDailyDoubleWagerSubmitted
                ) {
                    console.warn("No submitted Daily Double wager to judge.");
                    return;
                }

                const wager = currentDailyDoubleWager;

                const oldScore =
                    currentDailyDoublePlayer.score || 0;

                currentDailyDoublePlayer.score =
                    oldScore - wager;

                console.log(
                    "DAILY DOUBLE INCORRECT:",
                    currentDailyDoublePlayer.name,
                    "-", wager,
                    "OLD SCORE:", oldScore,
                    "NEW SCORE:", currentDailyDoublePlayer.score
                );

                // SCORE SCREEN
                io.emit("showScoreScreen", {
                    playerId: currentDailyDoublePlayer.playerId,
                    character: currentDailyDoublePlayer.character,
                    oldScore: oldScore,
                    score: currentDailyDoublePlayer.score,
                    earned: -wager,
                    players: getScorePlayers()
                });

                broadcastToUnity({
                    type: "showScoreScreen",
                    playerId: currentDailyDoublePlayer.playerId,
                    character: currentDailyDoublePlayer.character,
                    oldScore: oldScore,
                    score: currentDailyDoublePlayer.score,
                    earned: -wager
                });

                // Also update score state
                io.emit("scoreUpdate", {
                    playerId: currentDailyDoublePlayer.playerId,
                    playerName: currentDailyDoublePlayer.name,
                    score: currentDailyDoublePlayer.score
                });

                // Clear Daily Double state
                currentDailyDoublePlayer.dailyDoubleWager = 0;

                currentDailyDoubleWager = 0;
                currentDailyDoublePlayer = null;
                currentDailyDoubleWagerSubmitted = false;

                break;
            }
            
            case "showRound2Board": {
                console.log("HOST ACTION: showRound2Board");

                game.state = "playing";
                game.round = 2;
                game.hostScreen = "hostBoard";

                game.currentClueId = null;
                game.currentClueValue = 0;
                game.currentClueIsDailyDouble = false;

                buzzAccepted = false;
                currentBuzzPlayer = null;
                buzzedPlayerIds.clear();

                currentDailyDoubleWager = 0;
                currentDailyDoublePlayer = null;
                currentDailyDoubleWagerSubmitted = false;

                const round2BoardData = {
                    round: 2,
                    board: convertBoardForUnity(game.board)
                };

                console.log("================================");
                console.log("ROUND 2 BOARD DATA");
                console.log(
                    "CATEGORIES:",
                    Object.keys(game.board)
                );
                console.log("================================");

                // Players return to their character score/holding page
                // while the Round 2 board is being shown in Unity.
                setAllPlayerScreens("scorePage");

                game.players.forEach(player => {
                    io.to(player.socketId).emit("showScoreScreen", {
                        players: getScorePlayers()
                    });
                });

                // Unity leaves ScoresUI and returns to BoardIntroUI.
                // The complete Round 2 board is included so Unity can rebuild it.
                broadcastToUnity({
                    type: "showRound2BoardIntro",
                    round: 2,
                    board: round2BoardData.board
                });

                // Browser host gets its Round 2 board.
                io.emit(
                    "showRound2Board",
                    round2BoardData
                );

                io.emit(
                    "boardData",
                    round2BoardData
                );

                console.log("ROUND 2 BOARD SENT");

                break;
            }

            case "judgeFinalJeopardyAnswer": {
                const player =
                    game.players.find(
                        p =>
                            p.playerId ===
                            data.playerId
                    );

                if (!player)
                    return;

                const wager =
                    Number(
                        game.finalJeopardy.wagers[
                            player.playerId
                        ]
                    ) || 0;

                const correct =
                    data.correct === true;

                const oldScore =
                    Number(player.score) || 0;

                player.score =
                    correct
                        ? oldScore + wager
                        : oldScore - wager;

                game.finalJeopardy.judged[
                    player.playerId
                ] = true;

                if (correct && wager > 0) {
                    broadcastToUnity({
                        type: "showScoreScreen",
                        playerId:
                            player.playerId,
                        character:
                            player.character,
                        score:
                            player.score,
                        earned:
                            wager
                    });
                }

                const judgedCount =
                    game.players.filter(
                        p =>
                            game.finalJeopardy.judged[
                                p.playerId
                            ]
                    ).length;

                if (judgedCount === game.players.length) {
                    console.log(
                        "================================"
                    );

                    console.log(
                        "ALL FINAL JEOPARDY RESPONSES JUDGED"
                    );

                    console.log(
                        "REVEALING FINAL ANSWER"
                    );

                    console.log(
                        "================================"
                    );

                    game.state =
                        "finalAnswerReveal";

                    game.hostScreen =
                        "hostFinalJeopardyPg";


                    // -----------------------------------------
                    // UNITY - REVEAL FINAL ANSWER
                    // -----------------------------------------

                    broadcastToUnity({
                        type:
                            "revealFinalJeopardyAnswer"
                    });


                    // -----------------------------------------
                    // PLAYER PHONES - HOLDING SCREEN
                    // -----------------------------------------

                    game.players.forEach(
                        player => {

                            setPlayerScreen(
                                player,
                                "instructionsHoldingScreen"
                            );

                            io.to(
                                player.socketId
                            ).emit(
                                "showInstructionsHolding"
                            );
                        }
                    );


                    // -----------------------------------------
                    // HOST - ALLOW FINAL SCORE REVIEW
                    // -----------------------------------------

                    if (hostSocketId) {
                        io.to(
                            hostSocketId
                        ).emit(
                            "finalJeopardyJudgingComplete"
                        );
                    }
                }

                break;
            }

            case "showWinner": {
                console.log("HOST ACTION: showWinner");

                const sortedPlayers =
                    getScorePlayers()
                        .sort(
                            (a, b) =>
                                b.score - a.score
                        );

                if (sortedPlayers.length === 0) {
                    console.warn(
                        "Cannot show winner: no players."
                    );

                    break;
                }

                const winningScore =
                    sortedPlayers[0].score;

                // Supports ties properly.
                const winners =
                    sortedPlayers.filter(
                        player =>
                            player.score ===
                            winningScore
                    );

                game.state =
                    "winner";

                game.hostScreen =
                    "hostWinnerPg";

                setAllPlayerScreens(
                    "winnerPage"
                );

                io.emit(
                    "showWinner",
                    {
                        winners,
                        players:
                            sortedPlayers
                    }
                );

                broadcastToUnity({
                    type: "showWinner",
                    winners,
                    players:
                        sortedPlayers
                });

                console.log(
                    "WINNER(S):",
                    winners.map(
                        winner =>
                            winner.name
                    )
                );

                break;
            }

            case "showFinalScoreReview": {
                console.log(
                    "HOST ACTION: showFinalScoreReview"
                );

                const finalScores =
                    getScorePlayers()
                        .sort(
                            (a, b) =>
                                b.score - a.score
                        );

                game.state =
                    "finalScoreReview";

                game.hostScreen =
                    "hostFinalScoreReviewPg";

                setAllPlayerScreens(
                    "scorePage"
                );

                io.emit(
                    "finalJeopardyComplete",
                    {
                        players:
                            finalScores
                    }
                );

                broadcastToUnity({
                    type:
                        "finalJeopardyComplete",

                    players:
                        finalScores
                });

                break;
            }

            case "rollCredits": {
                console.log(
                    "================================"
                );

                console.log(
                    "HOST ACTION: ROLL CREDITS"
                );

                console.log(
                    "================================"
                );

                game.state =
                    "credits";

                game.hostScreen =
                    "hostCreditsPg";

                // Save reconnect state for every player.
                setAllPlayerScreens(
                    "thanksPage"
                );

                // Tell Unity to enable CreditsUI.
                broadcastToUnity({
                    type:
                        "rollCredits"
                });

                // Give each player their own final
                // information for the thanks screen.
                game.players.forEach(
                    player => {
                        io.to(
                            player.socketId
                        ).emit(
                            "thanksForPlaying",
                            {
                                playerId:
                                    player.playerId,

                                name:
                                    player.name,

                                character:
                                    player.character,

                                score:
                                    Number(
                                        player.score
                                    ) || 0
                            }
                        );
                    }
                );

                // Tell host browser to switch
                // to its credits control page.
                if (hostSocketId) {
                    io.to(
                        hostSocketId
                    ).emit(
                        "creditsStarted"
                    );
                }

                console.log(
                    "CREDITS STARTED"
                );

                break;
            }
        }
    });

    // PLAYER DAILY DOUBLE WAGER
    socket.on("dailyDoubleWagerSubmit", data => {
        console.log("DAILY DOUBLE WAGER SUBMIT RECEIVED:", data);

        if (!game.currentClueIsDailyDouble) {
            console.warn("Wager received but current clue is not a Daily Double.");
            return;
        }

        if (!currentDailyDoublePlayer) {
            console.warn("No Daily Double player selected.");
            return;
        }

        // Only the selected player may submit the wager.
        if (socket.id !== currentDailyDoublePlayer.socketId) {
            console.warn(
                "DAILY DOUBLE WAGER REJECTED - WRONG PLAYER:",
                socket.id
            );
            return;
        }

        if (currentDailyDoubleWagerSubmitted) {
            console.warn("Daily Double wager already submitted.");
            return;
        }

        const requestedWager = Math.max(0, parseInt(data?.wager) || 0);
        const playerScore = Number(currentDailyDoublePlayer.score) || 0;
        const maxWager = playerScore > 0 ? playerScore : 500;

        currentDailyDoubleWager =
            Math.min(requestedWager, maxWager);

        currentDailyDoublePlayer.dailyDoubleWager =
            currentDailyDoubleWager;

        currentDailyDoubleWagerSubmitted = true;
        currentBuzzPlayer = currentDailyDoublePlayer;

        setPlayerScreen(
            currentDailyDoublePlayer,
            "dailyDoubleSubmittedScreen"
        );

        console.log("================================");
        console.log("DAILY DOUBLE WAGER SUBMITTED");
        console.log("PLAYER:", currentDailyDoublePlayer.name);
        console.log("WAGER:", currentDailyDoubleWager);
        console.log("================================");

        // Selected player's phone
        io.to(currentDailyDoublePlayer.socketId).emit(
            "dailyDoubleWagerAccepted",
            {
                playerId: currentDailyDoublePlayer.playerId,
                playerName: currentDailyDoublePlayer.name,
                wager: currentDailyDoubleWager
            }
        );

        // Host browser
        if (hostSocketId) {
            io.to(hostSocketId).emit(
                "dailyDoubleWagerSubmitted",
                {
                    playerId: currentDailyDoublePlayer.playerId,
                    playerName: currentDailyDoublePlayer.name,
                    wager: currentDailyDoubleWager
                }
            );
        }

        // Reveal the actual Daily Double clue in Unity now.
        broadcastToUnity({
            type: "revealDailyDoubleClue",
            playerId: currentDailyDoublePlayer.playerId,
            playerName: currentDailyDoublePlayer.name,
            wager: currentDailyDoubleWager
        });
    });

    socket.on("finalJeopardyWagerSubmit",  data => {
        if (game.state !== "finalWager") {
            console.warn("Final wager received outside wager phase.");
            return;
        }

        const player = game.players.find(p => p.socketId ===socket.id);

        if (!player) {
            console.warn("Final wager player not found:", socket.id);
            return;
        }

        const playerScore =
            Number(player.score) || 0;

        const maxWager =
            playerScore > 0
                ? playerScore
                : 500;
        const requested = Math.max(0, parseInt(data?.wager) || 0);
        const wager = Math.min(requested, maxWager);

        game.finalJeopardy.wagers[
            player.playerId
        ] = wager;

        game.finalJeopardy.wagerSubmitted[
            player.playerId
        ] = true;

        console.log(
            "FINAL WAGER:",
            player.name,
            wager
        );

        io.to(player.socketId).emit(
            "finalJeopardyWagerAccepted",
            {
                wager
            }
        );

        const submitted = game.players.filter(p => game.finalJeopardy.wagerSubmitted[p.playerId]).length;
        const total = game.players.length;

        if (hostSocketId) {
            io.to(hostSocketId).emit("finalJeopardyWagerStatus",
                {
                    submitted,
                    total
                }
            );
        }

        if (total > 0 && submitted === total) {
            console.log("ALL FINAL JEOPARDY WAGERS SUBMITTED");

            if (hostSocketId) {
                io.to(hostSocketId).emit("finalJeopardyAllWagers");
            }

            // Unity removes the Final Jeopardy cover.
            broadcastToUnity({
                type: "finalJeopardyAllWagers"
            });
        }
    });

    socket.on("finalJeopardyAnswerSubmit", data => {
        if (
            game.state !==
            "finalAnswering"
        ) {
            return;
        }

        const player =
            game.players.find(
                p =>
                    p.socketId ===
                    socket.id
            );

        if (!player)
            return;

        if (
            game.finalJeopardy
                .answerSubmitted[
                    player.playerId
                ]
        ) {
            return;
        }

        const answer =
            String(
                data?.answer || ""
            )
                .trim()
                .slice(0, 200);

        if (!answer)
            return;

        game.finalJeopardy.answers[
            player.playerId
        ] = answer;

        game.finalJeopardy
            .answerSubmitted[
                player.playerId
            ] = true;

        const submitted =
            game.players.filter(
                p =>
                    game.finalJeopardy
                        .answerSubmitted[
                            p.playerId
                        ]
            ).length;

        const total =
            game.players.length;

        if (hostSocketId) {
            io.to(hostSocketId).emit(
                "finalJeopardyAnswerStatus",
                {
                    submitted,
                    total
                }
            );
        }

        if (
            total > 0 &&
            submitted === total
        ) {
            const responses =
                game.players.map(
                    p => ({
                        playerId:
                            p.playerId,

                        playerName:
                            p.name,

                        character:
                            p.character,

                        answer:
                            game.finalJeopardy
                                .answers[
                                    p.playerId
                                ] || "",

                        wager:
                            Number(
                                game.finalJeopardy
                                    .wagers[
                                        p.playerId
                                    ]
                            ) || 0,

                        score:
                            Number(
                                p.score
                            ) || 0
                    })
                );

            if (hostSocketId) {
                io.to(hostSocketId).emit(
                    "finalJeopardyResponses",
                    {
                        responses,
                        correctAnswer:
                            game.finalJeopardy
                                .answer
                    }
                );
            }
        }
    });

    // BUZZER SCREEN
    socket.on("buzz", () => {
        if (!buzzAccepted) {
            console.log("BUZZ REJECTED - buzzers are closed");
            return;
        }

        const player = game.players.find(p => p.socketId === socket.id);

        if (!player) {
            console.warn("BUZZ RECEIVED BUT PLAYER NOT FOUND:", socket.id);
            return;
        }

        if (buzzedPlayerIds.has(player.playerId)) {
            console.log("BUZZ REJECTED - PLAYER ALREADY ANSWERED THIS CLUE:", player.name);
            io.to(player.socketId).emit("buzzAlreadyUsed");
            return;
        }

        buzzAccepted = false;
        buzzedPlayerIds.add(player.playerId);
        currentBuzzPlayer = player;

        clearAnswerTimer();

        broadcastToUnity({
            type: "startAnswerTimer",
            duration: ANSWER_TIME_SECONDS
        });

        answerTimer = setTimeout(() => {
            if (
                !currentBuzzPlayer ||
                currentBuzzPlayer.playerId !== player.playerId
            ) {
                return;
            }

            console.log(
                "ANSWER TIME UP:",
                player.name
            );

            // Unity finishes the visible timer / shows TIME'S UP.
            broadcastToUnity({
                type: "answerTimeUp",
                playerId: player.playerId,
                playerName: player.name
            });

            // Tell host, but KEEP judgement open.
            if (hostSocketId) {
                io.to(hostSocketId).emit(
                    "answerTimeUp",
                    {
                        playerId: player.playerId,
                        playerName: player.name
                    }
                );
            }

            // Everyone goes back to their normal holding score page.
            setAllPlayerScreens("scorePage");

            game.players.forEach(gamePlayer => {
                io.to(gamePlayer.socketId).emit(
                    "showScoreScreen",
                    {
                        players: getScorePlayers(),
                        reason: "answerTimeUp"
                    }
                );
            });

            // IMPORTANT:
            // Do not clear currentBuzzPlayer.
            //
            // Host still has to press NO before this clue
            // can continue.

            buzzAccepted = false;

            answerTimer = null;

            console.log(
                "TIME EXPIRED - WAITING FOR HOST TO PRESS NO"
            );

        }, ANSWER_TIME_MS + ANSWER_TIMER_GRACE_MS);

        const buzzData = {
            playerId: player.playerId,
            playerName: player.name,
            character: player.character
        };

        game.players.forEach(player => {
            if (!buzzedPlayerIds.has(player.playerId)) {
                setPlayerScreen(player, "buzzerPage");
            }
        });

        console.log("BUZZ ACCEPTED:", player.name);

        if (hostSocketId) {
            io.to(hostSocketId).emit("buzzAccepted", buzzData);
        }

        game.players.forEach(p => {
            io.to(p.socketId).emit("buzzAccepted", buzzData);
        });

        broadcastToUnity({
            type: "buzzAccepted",
            playerId: player.playerId,
            playerName: player.name,
            character: player.character
        });
    });

    // DISCONNECT
    socket.on("disconnect", (reason) => {
        console.log("================================");
        console.log("SOCKET DISCONNECTED");
        console.log("Socket:", socket.id);
        console.log("Reason:", reason);
        console.log("================================");

        // HOST DISCONNECTED
        if (socket.isHost) {
            console.log("Host temporarily disconnected.");
            socket.isHost = false;

            if (hostDisconnectTimer) {
                clearTimeout(hostDisconnectTimer);
                hostDisconnectTimer = null;
            }

            hostDisconnectTimer = setTimeout(() => {
                if (hostSocketId === socket.id) {
                    hostConnected = false;
                    hostSocketId = null;
                    io.emit("hostStatus", false);

                    console.log("================================");
                    console.log("HOST RECONNECT WINDOW EXPIRED");
                    console.log("Host is now disconnected.");
                    console.log("================================");
                }

                hostDisconnectTimer = null;
            }, HOST_RECONNECT_WINDOW);
        }

        // PLAYER DISCONNECT
        const player = game.players.find(p => p.socketId === socket.id);
        if (!player) { 
            return;
        }

        console.log(
            player.name + " temporarily disconnected"
        );

        player.disconnected = true;
        player.disconnectTime = Date.now();

        io.emit(
            "playerList",
            game.players.map(p => ({
                playerId: p.playerId,
                name: p.name,
                character: p.character,
                disconnected: p.disconnected
            }))
        );
    });

    socket.on("leavePlayer", ({ playerId }) => {
        const player = game.players.find(p => p.playerId === playerId);
        if (!player) return;

        if (player.socketId !== socket.id) {
            console.warn("Unauthorized leavePlayer attempt:", socket.id, playerId);
            return;
        }
        console.log(player.name + " left character selection");
        lockedCharacters.delete(player.characterKey);

        game.players = game.players.filter(p => p.playerId !== playerId);

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
