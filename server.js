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

// HOST CONNECTION
let hostConnected = false;
let hostSocketId = null;

const HOST_RECONNECT_TOKEN = "HOST_" + Math.random().toString(36).substring(2) + "_" + Date.now();

let hostDisconnectTimer = null;
const HOST_RECONNECT_WINDOW = 15000;

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

    transports: [
        "websocket",
        "polling"
    ],

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
    hostScreen: "hostJoinPg"
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

    socket.emit(
        "playerList",
        game.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            character: p.character,
            score: p.score,
            disconnected: p.disconnected
        }))
    );

    socket.emit(
        "lockedCharacters",
        Array.from(lockedCharacters)
    );

    socket.emit("gameStateSync", {
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
        players: game.players.length,
        boardCategories:
            Object.keys(game.board).length
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
            const reconnectToken = socket.handshake.auth?.hostReconnectToken;

            if (reconnectToken && reconnectToken === HOST_RECONNECT_TOKEN) {
                console.log("================================");
                console.log("HOST MANUAL RECONNECT ACCEPTED");
                console.log("Socket:", socket.id);
                console.log("================================");

                if (hostDisconnectTimer) {
                    clearTimeout(hostDisconnectTimer);
                    hostDisconnectTimer = null;
                }

                hostConnected = true;
                hostSocketId = socket.id;
                socket.isHost = true;
                socket.data.joined = true;

                console.log("================================");
                console.log("HOST CONNECTED");
                console.log("Socket:", socket.id);
                console.log("================================");

                // Tell this browser specifically that it is the host
                socket.emit("hostReconnectToken", HOST_RECONNECT_TOKEN);
                socket.emit("hostConfirmed");

                sendHostState(socket);
                io.emit("hostStatus", true);

                return;
            }

            if (hostConnected) {
                console.log("HOST CONNECTION REJECTED - HOST ALREADY CONNECTED");
                socket.emit("hostTaken");
                return;
            }

            hostConnected = true;
            hostSocketId = socket.id;
            socket.isHost = true;
            socket.data.joined = true;

            console.log("================================");
            console.log("HOST CONNECTED");
            console.log("Socket:", socket.id);
            console.log("================================");

            socket.emit("hostReconnectToken", HOST_RECONNECT_TOKEN);

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

        // PLAYER RECONNECT
        if (existingPlayer && existingPlayer.disconnected) {
            console.log(
                "PLAYER RECONNECT:",
                existingPlayer.name
            );

            existingPlayer.socketId = socket.id;
            existingPlayer.disconnected = false;
            existingPlayer.disconnectTime = null;

            socket.data.joined = true;

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
                round: game.round,
                players: game.players,
                board: convertBoardForUnity(game.board),
                lockedCharacters: Array.from(lockedCharacters),
                currentClueId: game.currentClueId,
                currentClueValue: game.currentClueValue,
                currentClueIsDailyDouble: game.currentClueIsDailyDouble,
                hostScreen: game.hostScreen || "hostJoinPg"
            });

            broadcastToUnity({
                type: "playerList",
                players: game.players.map(p => ({
                    playerId: p.playerId,
                    name: p.name,
                    characterId: p.characterKey
                }))
            });

            return;
        }

        // PLAYER WITH SAME ID ALREADY CONNECTED
        if (existingPlayer) {
            console.log(
                "Player ID already connected:",
                playerId
            );

            socket.emit("joinError", {
                message: "Player is already connected."
            });

            return;
        }

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
            //io.emit("showInstructionsHolding");

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
            console.log("STARTING ROUND 2 TRANSITION");

            game.round = 2;
            game.state = "midCutscene";
            game.hostScreen = "hostMidCutscenePg";

            game.currentClueId = null;
            game.currentClueValue = 0;
            game.currentClueIsDailyDouble = false;

            buzzAccepted = false;
            currentBuzzPlayer = null;

            currentDailyDoubleWager = 0;
            currentDailyDoublePlayer = null;
            currentDailyDoubleWagerSubmitted = false;

            generateBoard(2);

            // HOST
            io.emit("round2Transition", {
                round: 2
            });

            // UNITY
            broadcastToUnity({
                type: "midCutscene",
                round: 2
            });

            console.log("ROUND 2 MID-CUTSCENE STARTED");

            return;
        }

        // OTHER HOST ACTIONS
        switch (data.type) {
            case "showInstructions":
                console.log("HOST ACTION: showInstructions");
                game.hostScreen = "hostInstructionsPg";
                game.state = "playing";
                io.emit("showInstructionsHolding");
                broadcastToUnity({ type: "showInstructions" });
                break;

            case "showInstrucCutscene":
                console.log("HOST ACTION: showInstrucCutscene");

                game.hostScreen = "hostInstrucCutscenePg";

                broadcastToUnity({
                    type: "showInstrucCutscene"
                });

                break;

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

                if (!currentBuzzPlayer) {
                    console.warn("No player to award points to.");
                    return;
                }

                if(game.currentClueIsDailyDouble){
                    const wager=currentBuzzPlayer.dailyDoubleWager||0;

                    currentBuzzPlayer.score=
                        (currentBuzzPlayer.score||0)+wager;

                    currentBuzzPlayer.correctAnswers=
                        (currentBuzzPlayer.correctAnswers||0)+1;

                    console.log(
                        "DAILY DOUBLE CORRECT:",
                        currentBuzzPlayer.name,
                        "wager:",
                        wager,
                        "new score:",
                        currentBuzzPlayer.score
                    );

                    io.emit("showScoreScreen", {
                        players: getScorePlayers()
                        /*
                        players: game.players.map(player => {
                            const character = characters.find(
                                c => c.name === player.character
                            );

                            return {
                                playerId: player.playerId,
                                character: player.character,
                                score: player.score || 0,
                                animation: character?.animations?.idle || null
                            };
                        })
                        */
                    });

                    broadcastToUnity({
                        type:"showScoreScreen",
                        playerId:currentBuzzPlayer.playerId,
                        character:currentBuzzPlayer.character,
                        score:currentBuzzPlayer.score,
                        earned:wager
                    });

                    currentBuzzPlayer.dailyDoubleWager=0;

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

                buzzAccepted = true;
                currentBuzzPlayer = null;

                io.emit("resumeBuzzing");

                broadcastToUnity({
                    type: "resumeBuzzing"
                });

                break;

            case "roundComplete":
                console.log("ROUND", game.round, "COMPLETE");
                game.state = "roundComplete";

                io.emit(
                    "roundComplete",
                    {
                        round: game.round
                    }
                );

                broadcastToUnity({
                    type: "roundComplete",
                    round: game.round
                });

                break;

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
                        playerName: player.name
                    });
                });

                break;
            }

            case "dailyDoubleWager": {
                console.log("HOST ACTION: dailyDoubleWager");

                if (!game.currentClueIsDailyDouble) {
                    console.warn("Wager received but current clue is not a Daily Double.");
                    return;
                }

                if (!currentDailyDoublePlayer) {
                    console.warn("No Daily Double player selected.");
                    return;
                }

                const requestedWager = Math.max(0, parseInt(data.payload?.wager) || 0);
                const maxWager = Math.max(game.currentClueValue || 0, currentDailyDoublePlayer.score || 0);

                currentDailyDoubleWager = Math.min(requestedWager, maxWager);
                currentDailyDoublePlayer.dailyDoubleWager = currentDailyDoubleWager;
                currentDailyDoubleWagerSubmitted = true;
                currentBuzzPlayer = currentDailyDoublePlayer;

                console.log("================================");
                console.log("DAILY DOUBLE WAGER SUBMITTED");
                console.log("PLAYER:", currentDailyDoublePlayer.name);
                console.log("WAGER:", currentDailyDoubleWager);
                console.log("================================");

                // SELECTED PLAYER
                io.to(currentDailyDoublePlayer.socketId).emit("dailyDoubleWagerAccepted", {
                    playerId: currentDailyDoublePlayer.playerId,
                    playerName: currentDailyDoublePlayer.name,
                    wager: currentDailyDoubleWager
                });

                // HOST ONLY
                if (hostSocketId) {
                    io.to(hostSocketId).emit("dailyDoubleWagerSubmitted", {
                        playerId: currentDailyDoublePlayer.playerId,
                        playerName: currentDailyDoublePlayer.name,
                        wager: currentDailyDoubleWager
                    });
                }

                // UNITY
                broadcastToUnity({
                    type: "dailyDoubleWager",
                    playerId: currentDailyDoublePlayer.playerId,
                    playerName: currentDailyDoublePlayer.name,
                    wager: currentDailyDoubleWager
                });

                break;
            }

            case "dailyDoubleCorrect": {
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

                currentDailyDoubleWager = 0;
                currentDailyDoublePlayer = null;
                currentDailyDoubleWagerSubmitted = false;

                const round2BoardData = {
                    round: 2,
                    board: convertBoardForUnity(game.board)
                };

                console.log("================================");
                console.log("ROUND 2 BOARD DATA");
                console.log("CATEGORIES:", Object.keys(game.board));

                for (const categoryName in game.board) {
                    console.log(
                        categoryName,
                        "VALUES:",
                        Object.keys(game.board[categoryName])
                    );
                }

                console.log("================================");

                broadcastToUnity({
                    type: "showRound2BoardIntro",
                    ...round2BoardData
                });

                io.emit("showRound2Board", round2BoardData);
                io.emit("boardData", round2BoardData);

                console.log("ROUND 2 BOARD SENT");
                break;
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

        const buzzData = {
            playerId: player.playerId,
            playerName: player.name,
            character: player.character
        };

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
