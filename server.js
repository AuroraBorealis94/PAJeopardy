const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// Cloud server
const PORT = process.env.PORT || 3000;
const io = require("socket.io")(http, {
  cors: {
    origin: "*"
  }
});

// Simple 4-letter random room code
//const ROOM_CODE = Math.random().toString(36).substring(2,6).toUpperCase();
// Constant Room code
const ROOM_CODE = "PA26"; // fixed code
console.log("Room code for players to join:", ROOM_CODE);

// This lets players open a webpage
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Store players
let players = [];

// When someone connects
io.on("connection", (socket) => {
    console.log("A player connected:", socket.id);

    // Player joins
    socket.on("join", (name) => {
        players.push({ id: socket.id, name });
        console.log(name + " joined the game");

        // Send updated player list to everyone
        io.emit("playerList", players);
    });

    // Player selects a question
    socket.on("selectQuestion", (data) => {
        console.log("Question selected:", data);
        io.emit("questionSelected", data);
    });

    // Player submits answer
    socket.on("submitAnswer", (data) => {
        console.log("Answer submitted:", data);
        io.emit("answerSubmitted", data);
    });

    // Player disconnects
    socket.on("disconnect", () => {
        console.log("Player disconnected");

        players = players.filter(p => p.id !== socket.id);
        io.emit("playerList", players);
    });
});

// Start server
//http.listen(3000, "0.0.0.0", () => {
//    console.log("Server running on port 3000");
//});
http.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
