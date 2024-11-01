// Etymology data for word sequences
const wordSequencesList = [
  {
    sequence: [
      { word: "bread", language: "Modern English", translation: "bread" },
      { word: "bred", language: "Middle English", translation: "bread" },
      { word: "brēad", language: "Old English", translation: "piece of food" },
      { word: "braudą", language: "Proto-Germanic", translation: "bread" },
      { word: "*bʰrew-", language: "Proto-Indo-European", translation: "to boil, to brew" }
    ]
  },
  // Add more word sequences here
];

let wordSequence;
let currentStage = 0;
let previousBubble = null;
let gameHeight = 0; // To keep track of total game height for camera movement

const gameArea = document.getElementById("game");

// Function to get random distractor words starting with the same letter
function getDistractors(correctWord, number) {
  const firstLetter = correctWord.charAt(0).toLowerCase();
  const possibleWords = ["bramble", "brisk", "breakfast", "brave", "brown", "branch", "bridge", "brother", "bright"];
  const filteredWords = possibleWords.filter(
    word => word.charAt(0).toLowerCase() === firstLetter && word !== correctWord
  );
  const distractors = [];
  for (let i = 0; i < number && filteredWords.length > 0; i++) {
    const index = Math.floor(Math.random() * filteredWords.length);
    distractors.push(filteredWords.splice(index, 1)[0]);
  }
  return distractors;
}

// Start the game
function startGame() {
  // Randomly select a word sequence for each playthrough
  wordSequence = wordSequencesList[Math.floor(Math.random() * wordSequencesList.length)].sequence;
  currentStage = 0;
  gameArea.innerHTML = "";
  gameHeight = 0;
  previousBubble = null;
  loadStage();
}

function loadStage() {
  const stageData = wordSequence[currentStage];

  // Create the correct bubble
  const correctBubble = createBubble(stageData, true);

  // Position the correct bubble
  let bubbleY = -currentStage * 200; // Space bubbles vertically
  if (currentStage === 0) {
    // First bubble at bottom center
    bubbleY = 0;
    correctBubble.style.bottom = "20px";
    correctBubble.style.left = "50%";
    correctBubble.style.transform = "translateX(-50%)";
  } else {
    correctBubble.style.top = `${gameHeight}px`;
    correctBubble.style.left = "50%";
    correctBubble.style.transform = "translateX(-50%)";
  }

  // Update game height
  gameHeight += 200;

  // Create distractor bubbles
  const distractorWords = getDistractors(stageData.word, 3);
  distractorWords.forEach(word => {
    const distractorBubble = createBubble({ word }, false);
    distractorBubble.style.top = `${gameHeight - 200 + Math.random() * 100}px`; // Position near correct bubble
    distractorBubble.style.left = `${Math.random() * 80 + 10}%`; // Random horizontal position
  });

  // Move camera up to the new bubble
  if (currentStage > 0) {
    gameArea.style.transform = `translateY(${-gameHeight + window.innerHeight / 2}px)`;
  }
}

function createBubble(wordData, isCorrect) {
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="word">${wordData.word}</div>`;

  if (isCorrect) {
    bubble.classList.add("correct");
    // Store language and translation for later reveal
    bubble.dataset.language = wordData.language;
    bubble.dataset.translation = wordData.translation;
  }

  // Handle bubble click
  bubble.onclick = () => {
    if (isCorrect) {
      // Reveal language and translation
      bubble.classList.add("revealed");
      bubble.innerHTML = `
        <div class="word">${wordData.word}</div>
        <div class="language">${wordData.language}</div>
        <div class="translation">${wordData.translation}</div>
      `;

      // Remove wrong bubbles
      const wrongBubbles = document.querySelectorAll(".bubble:not(.correct):not(.exploded)");
      wrongBubbles.forEach(b => {
        b.classList.add("explode");
        b.classList.add("exploded");
      });

      // Connect bubbles
      if (previousBubble) {
        createLine(previousBubble, bubble);
      }
      previousBubble = bubble;
      currentStage++;
      if (currentStage < wordSequence.length) {
        // Delay before loading next stage
        setTimeout(loadStage, 1000);
      } else {
        // Game completed
        setTimeout(() => {
          alert("Congratulations! You've completed the sequence!");
          startGame();
        }, 1000);
      }
    } else {
      // Wrong bubble clicked
      bubble.classList.add("explode");
      bubble.classList.add("exploded");
      setTimeout(() => {
        alert("Game Over!");
        startGame();
      }, 500);
    }
  };
  gameArea.appendChild(bubble);
  return bubble;
}

function createLine(bubble1, bubble2) {
  const line = document.createElement("div");
  line.className = "line";

  const rect1 = bubble1.getBoundingClientRect();
  const rect2 = bubble2.getBoundingClientRect();

  // Positions relative to the game area
  const x1 = rect1.left + rect1.width / 2 - gameArea.getBoundingClientRect().left;
  const y1 = rect1.top + rect1.height / 2 - gameArea.getBoundingClientRect().top;
  const x2 = rect2.left + rect2.width / 2 - gameArea.getBoundingClientRect().left;
  const y2 = rect2.top + rect2.height / 2 - gameArea.getBoundingClientRect().top;

  const length = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

  line.style.width = `${length}px`;
  line.style.top = `${y1}px`;
  line.style.left = `${x1}px`;
  line.style.transform = `rotate(${angle}deg)`;

  gameArea.appendChild(line);
}

startGame();
