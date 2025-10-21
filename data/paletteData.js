export default {
  "defaultTile": "grass",
  "tiles": [
    {
      "key": "grass",
      "name": "Grass",
      "color": "#8BC34A",
      "texture": "grass_tile",
      "transitions": {
        "water": {
          "north": "grass_edge_water_n",
          "south": "grass_edge_water_s",
          "east": "grass_edge_water_e",
          "west": "grass_edge_water_w"
        },
        "road": {
          "north": "grass_edge_road_n",
          "south": "grass_edge_road_s",
          "east": "grass_edge_road_e",
          "west": "grass_edge_road_w"
        }
      }
    },
    { "key": "forest", "name": "Forest", "color": "#4CAF50", "texture": "forest_tile" },
    { "key": "water", "name": "Water", "color": "#2196F3", "texture": "water_tile" },
    { "key": "mountain", "name": "Mountain", "color": "#795548", "texture": "mountain_tile" },
    {
      "key": "road",
      "name": "Road",
      "color": "#FF9800",
      "texture": "road_tile",
      "transitions": {
        "grass": {
          "north": "road_edge_grass_n",
          "south": "road_edge_grass_s",
          "east": "road_edge_grass_e",
          "west": "road_edge_grass_w"
        }
      }
    }
  ]
};
