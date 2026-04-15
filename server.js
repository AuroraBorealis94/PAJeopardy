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
    { name: "Joe the Elf", front: "/characters/fancydancerblack.png", back: "/characters/joetheelf.png" },
    { name: "Tricerex", front: "/characters/fancydancerblack.png", back: "/characters/tricerex.png" },
    { name: "Deerhead", front: "/characters/fancydancerblack.png", back: "/characters/deerhead.png" },
    { name: "Janice Mowes", front: "/characters/fancydancerblack.png", back: "/characters/janicemowes.png" },
    { name: "Old Sawyer", front: "/characters/fancydancerblack.png", back: "/characters/oldsawyer.png" },
    { name: "Jesus", front: "/characters/fancydancerblack.png", back: "/characters/jesus.png" },
    { name: "Fancy Dancer", front: "/characters/fancydancerblack.png", back: "/characters/fancydancerpink.png" },
    { name: "Donna", front: "/characters/fancydancerblack.png", back: "/characters/donna.png" },
    { name: "Lorenzo", front: "/characters/fancydancerblack.png", back: "/characters/lorenzo.png" },
    { name: "Caity Satyr", front: "/characters/fancydancerblack.png", back: "/characters/caitysatyr.png" },
    { name: "The Boss", front: "/characters/fancydancerblack.png", back: "/characters/theboss.png" }
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

    console.log("A player connected:", socket.id);

    // JOIN LOBBY
    socket.on("join", ({name, character}) => {

        // ONE JOIN PER DEVICE
        const alreadyJoined = game.players.find(p => p.id === socket.id);
        if (alreadyJoined) return;

        game.players.push({
            id: socket.id,
            name: name,
            character: character.name
        });

        console.log(name + " joined the lobby");

        io.emit("playerList", game.players);
        broadcastToUnity({
            type: "playerList",
            players: game.players.map(p => ({
                id: p.id,
                name: p.name,
                characterId: character.name.toLowerCase()
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
        game.players = game.players.filter(p => p.id !== socket.id);
        io.emit("playerList", game.players);
    });
});

// START SERVER
http.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
});
