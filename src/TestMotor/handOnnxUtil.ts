
/**
 * Groups objects based on Euclidean distance of their .x and .y properties.
 * @param {Array} boxes - Array of objects like {x: 10, y: 20, ...}
 * @param {number} threshold - Max distance to be in the same group
 * @returns {Array<Array<number>>} Array of index groups
 */
function groupBoxes(boxes, threshold) {
  const n = boxes.length;
  if (n === 0) return [];

  const cellSize = threshold;
  const grid = new Map();
  const thresholdSq = threshold * threshold;

  // 1. Hash boxes into the grid
  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    const gx = Math.floor(b.x / cellSize);
    const gy = Math.floor(b.y / cellSize);
    const key = `${gx},${gy}`;

    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  const visited = new Uint8Array(n);
  const groups = [];

  // 2. Grouping
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;

    const currentGroup = [];
    const queue = [i];
    visited[i] = 1;

    let head = 0; // Faster than shift()
    while (head < queue.length) {
      const currIdx = queue[head++];
      currentGroup.push(currIdx);

      const b1 = boxes[currIdx];
      const gx = Math.floor(b1.x / cellSize);
      const gy = Math.floor(b1.y / cellSize);

      // Check 3x3 neighborhood
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighborKey = `${gx + dx},${gy + dy}`;
          const cellNeighbors = grid.get(neighborKey);

          if (cellNeighbors) {
            for (let j = 0; j < cellNeighbors.length; j++) {
              const neighborIdx = cellNeighbors[j];
              
              if (!visited[neighborIdx]) {
                const b2 = boxes[neighborIdx];
                // Squared Euclidean Distance
                const distSq = (b1.x - b2.x) ** 2 + (b1.y - b2.y) ** 2;
                
                if (distSq <= thresholdSq) {
                  visited[neighborIdx] = 1;
                  queue.push(neighborIdx);
                }
              }
            }
          }
        }
      }
    }
    groups.push(currentGroup);
  }
  const new_groups = []
  groups.map(group => {
    new_groups.push(boxes[group[0]])
  });
  // console.log(groups, new_groups)
  return new_groups;
}

/**
 * 
 * Return in radians the orientation of the hand relative to the vertical line, which is a vector.
 */

function handOrientation(box) {
    // bbox: [realX - realW / 2, realY - realH / 2, realX + realW / 2, realY + realH / 2],
    //             score: score,
    //             landmarks: landmarks,
    //             class: 'palm'
    // cx
    // cy
    const left = box.landmarks[2]
    // const right = box.landmarks[3]
    // const middle_x = (left.x + right.x )/ 2
    // const middle_y = (left.y + right.y)/2
    // const middle = {x: middle_x, y: middle_y}
    const hand_direction = {x: left.x - box.x, y: left.y - box.y}
    return Math.atan2(hand_direction.y, hand_direction.x)

}

// function dot(x,y){
//   return (x.x * y.x )+ x.y * y.y
// }

// function length(x){
//   return Math.sqrt(Math.pow(x.x,2) + Math.pow(x.y,2))
// }


/**
 * 
 * Returns whether the current hand is a left or right hand.
 * 
 */
function left_or_right(box){
      // bbox: [realX - realW / 2, realY - realH / 2, realX + realW / 2, realY + realH / 2],
    //             score: score,
    //             landmarks: landmarks,
    //             class: 'palm'
    // cx
    // cy
  const first_landmark = box.landmarks[0];
  return first_landmark.x > box.x ? "Left" : "Right"
}

export {groupBoxes, handOrientation, left_or_right};


