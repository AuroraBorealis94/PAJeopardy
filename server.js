const express = require("express");
const app = express();
const http = require("http").createServer(app);

app.use("/characters", express.static("characters"));
app.use("/fonts", express.static("fonts"));
app.use("/backgrounds", express.static("backgrounds"));
app.use("/sprites", express.static("sprites"));
app.use("/confetti", express.static("public/confetti"));

// BRIDGE FROM SOCKET.IO TO WEBSOCKET
const WebSocket = require("ws");
const wss = new WebSocket.Server({ server: http });

wss.on("connection", (ws) => {
    console.log("Unity connected via WebSocket");
});

let lockedCharacters = new Set();

// SOCKET.IO
//const io = require("socket.io")(http);
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
            { clue: "Water freezes at this temperature in Celsius", answer: "0" }
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

// ROOM CODE
//const ROOM_CODE = Math.random().toString(36).substring(2,6).toUpperCase();
const ROOM_CODE = "PA26"; // fixed code
console.log("Room code for players to join:", ROOM_CODE);

// WEBPAGE
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// NEW CONNECTION
io.on("connection", (socket) => {
    // SEND INFO TO WEB
    socket.emit("roomCode", ROOM_CODE);
    socket.emit("characterList", characters);
    socket.emit("lockedCharacters", Array.from(lockedCharacters));

    console.log("A player connected:", socket.id);

    // JOIN LOBBY
    /*
    socket.on("join", ({name, character}) => {

        // ONE JOIN PER DEVICE
        const alreadyJoined = game.players.find(p => p.id === socket.id);
        if (alreadyJoined) return;

        game.players.push({
            id: socket.id,
            name: name,
            character: character
        });

        console.log(name + " joined the lobby");

        io.emit("playerList", game.players);
        broadcastToUnity({
            type: "playerList",
            players: game.players.map(p => ({
                id: p.id,
                name: p.name,
                characterId: p.character.toLowerCase()
            }))
        });
    });*/

    socket.on("join", ({name, character}) => {

        // ONE JOIN PER DEVICE
        const alreadyJoined = game.players.find(p => p.id === socket.id);
        if (alreadyJoined) return;

        // BLOCK if character already taken
        if (lockedCharacters.has(character)) {
            socket.emit("characterTaken", character);
            return;
        }

        // LOCK the character
        lockedCharacters.add(character);

        game.players.push({
            id: socket.id,
            name: name,
            character: character
        });

        console.log(name + " joined the lobby as " + character);

        // SEND updated locked list to everyone
        io.emit("lockedCharacters", Array.from(lockedCharacters));

        io.emit("playerList", game.players);

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
    /*
    socket.on("disconnect", () => {
        game.players = game.players.filter(p => p.id !== socket.id);
        io.emit("playerList", game.players);
    });*/

    socket.on("disconnect", () => {
        const player = game.players.find(p => p.id === socket.id);

        if (player) {
            lockedCharacters.delete(player.character);
        }

        game.players = game.players.filter(p => p.id !== socket.id);

        // UPDATE EVERYONE
        io.emit("lockedCharacters", Array.from(lockedCharacters));
        io.emit("playerList", game.players);
    });
});

// START SERVER
http.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
});
