// Etymology data for each word sequence
const wordSequences = {
    "bread": [
        { word: "bread", language: "Modern English", translation: "bread" },
        { word: "bred", language: "Middle English", translation: "bread" },
        { word: "brēad", language: "Old English", translation: "piece of food" },
        { word: "brauda", language: "Proto-Germanic", translation: "piece of food" },
        { word: "bhrēh₂dʰ-", language: "Proto-Indo-European", translation: "to boil, to bake" }
    ]
};

const gameArea = document.getElementById("game");
let currentStage = 0; // Track the current stage
let currentWord = "bread"; // Track the current word sequence

// Function to start or restart the game
function startGame() {
    currentStage = 0;
    loadStage();
}

// Function to load each stage of the word sequence
function loadStage() {
    gameArea.innerHTML = ""; // Clear previous bubbles

    const stageData = wordSequences[currentWord][currentStage];
    createBubble(stageData, true); // Create the correct bubble

    // Generate distractor bubbles with similar starting letters
    for (let i = 0; i < 3; i++) {
        let distractorWord = "brandom" + i; // Example distractor
        createBubble({ word: distractorWord, language: "", translation: "" }, false);
    }
}

// Function to create a bubble
function createBubble(wordData, isCorrect) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerText = wordData.word;
    bubble.style.top = Math.random() * 80 + "%";
    bubble.style.left = Math.random() * 80 + "%";

    // Handle click event for correct/incorrect answers
    bubble.onclick = () => {
        if (isCorrect) {
            currentStage++;
            if (currentStage < wordSequences[currentWord].length) {
                loadStage();
            } else {
                alert("Congratulations! You've completed the sequence!");
                startGame(); // Restart the game
            }
        } else {
            bubble.classList.add("explode"); // Explosion effect
            setTimeout(() => {
                alert("Game Over!");
                startGame(); // Restart the game
            }, 500);
        }
    };

    gameArea.appendChild(bubble);
}

// Start the game
startGame();
