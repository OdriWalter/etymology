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
  // You can add more word sequences here
];

let wordSequence;
let currentStage = 0;
let previousBubble = null;

const gameArea = document.getElementById("game");

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

function startGame() {
  wordSequence = wordSequencesList[Math.floor(Math.random() * wordSequencesList.length)].sequence;
  currentStage = 0;
  gameArea.innerHTML = "";
  previousBubble = null;
  gameArea.style.transform = `translateY(0px)`; // Reset camera position
  loadStage();
}

function loadStage() {
  const stageData = wordSequence[currentStage];

  // Create the correct bubble
  const correctBubble = createBubble(stageData, true);

  // Position the correct bubble
  let bubbleY;
  if (currentStage === 0) {
    // First bubble at the bottom center
    bubbleY = window.innerHeight - 160; // Adjusted for bubble height
    correctBubble.style.top = `${bubbleY}px`;
    correctBubble.style.left = `calc(50% - 60px)`; // Center horizontally
  } else {
    // Subsequent bubbles above previous ones
    const previousBubbleRect = previousBubble.getBoundingClientRect();
    bubbleY = parseInt(previousBubble.style.top) - 200; // Space bubbles vertically
    correctBubble.style.top = `${bubbleY}px`;
    correctBubble.style.left = `calc(50% - 60px)`;
  }

  // Create distractor bubbles
  const distractorWords = getDistractors(stageData.word, 3);
  distractorWords.forEach(word => {
    const distractorBubble = createBubble({ word }, false);
    // Position distractor bubbles randomly around the correct bubble
    distractorBubble.style.top = `${bubbleY + (Math.random() * 100 - 50)}px`;
    distractorBubble.style.left = `${Math.random() * (window.innerWidth - 120)}px`;
  });

  // Move camera to focus on the new bubble
  if (currentStage > 0) {
    const cameraShift = bubbleY - (window.innerHeight / 2) + 60; // Center the bubble
    gameArea.style.transform = `translateY(${-cameraShift}px)`;
  }
}

function createBubble(wordData, isCorrect) {
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="word">${wordData.word}</div>`;

  if (isCorrect) {
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

      // Change bubble color after revealing
      bubble.classList.add("correct");

      // Remove wrong bubbles
      const wrongBubbles = document.querySelectorAll(".bubble:not(.revealed)");
      wrongBubbles.forEach(b => {
        b.classList.add("explode");
        b.classList.add("exploded");
      });

      // Connect bubbles
      if (previousBubble) {
        // Delay to ensure bubbles have rendered
        setTimeout(() => {
          createLine(previousBubble, bubble);
        }, 50);
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
