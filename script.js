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
let previousBubble = null; // Track the previous bubble for connecting lines

// Function to start or restart the game
function startGame() {
    currentStage = 0;
    gameArea.innerHTML = ""; // Clear game area
    loadStage();
}

// Function to load each stage of the word sequence
function loadStage() {
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

    if (isCorrect) {
        bubble.classList.add("correct");
        // Display language and translation for correct bubbles
        const language = document.createElement("div");
        language.className = "language";
        language.innerText = wordData.language;

        const translation = document.createElement("div");
        translation.className = "translation";
        translation.innerText = wordData.translation;

        bubble.appendChild(language);
        bubble.appendChild(translation);
    }

    // Set random position for bubbles
    bubble.style.top = Math.random() * 80 + "%";
    bubble.style.left = Math.random() * 80 + "%";

    // Handle click event for correct/incorrect answers
    bubble.onclick = () => {
        if (isCorrect) {
            // If correct, connect this bubble to the previous one
            if (previousBubble) {
                createLine(previousBubble, bubble);
            }
            previousBubble = bubble; // Update the previous bubble

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

// Function to create a line connecting two bubbles
function createLine(bubble1, bubble2) {
    const line = document.createElement("div");
    line.className = "line";

    const x1 = bubble1.offsetLeft + bubble1.offsetWidth / 2;
    const y1 = bubble1.offsetTop + bubble1.offsetHeight / 2;
    const x2 = bubble2.offsetLeft + bubble2.offsetWidth / 2;
    const y2 = bubble2.offsetTop + bubble2.offsetHeight / 2;

    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

    line.style.width = `${length}px`;
    line.style.top = `${y1}px`;
    line.style.left = `${x1}px`;
    line.style.transform = `rotate(${angle}deg)`;

    gameArea.appendChild(line);
}

// Start the game
startGame();
