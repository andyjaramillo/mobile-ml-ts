import { drawLineWithArrow } from "./drawing_utils"
import { NotifyType } from "./Notification"
import { WARNINGS } from "./warnings"
let missingMarkersNotificationId = -1
let orientationID = -1
let diagonalID = -1
let normalizedAreaId=-1

const HYPERPARAMETERS = {
    //visibility_method: Visibility.Orientation,
    minimum_marker_area: 0.009,
    minimum_diagonal_ratio_max: 0.5,
    minimum_diagonal_ratio_min: 0.2,
    orientation_margin: 0.3 
}


function markerCenter(marker, frameWidth, frameHeight, inputW?, inputH?) {
    const corners = marker.corners;
    let x = (corners[1].x + corners[3].x) / 2;
    let y = (corners[1].y + corners[3].y) / 2;
    if (inputW && inputH) {
        x = (x / inputW) * frameWidth;
        y = (y / inputH) * frameHeight;
    }
    return { x, y };
}

function drawOrientationArrow(canvas, sorted_markers, final_res, frameWidth, frameHeight, inputW?, inputH?) {
    if (!canvas) return;

    const marker0 = sorted_markers.find(m => m.id === 2);
    const marker2 = sorted_markers.find(m => m.id === 6);
    if (!marker0 || !marker2) return;

    const two = markerCenter(marker2, frameWidth, frameHeight, inputW, inputH);
    const zero = markerCenter(marker0, frameWidth, frameHeight, inputW, inputH);
    const label = `final_res: ${final_res.toFixed(4)}`;
    drawLineWithArrow(canvas, two.x, two.y, zero.x, zero.y, label);
}



function NonVisibleMarks(canvas, markers, notif: NotifyType, frameWidth, frameHeight, inputW?, inputH?){
    //notif.info(String(normalized_marker_area(markers, frameWidth, frameHeight)))
    const sorted_markers = [...markers].sort((a, b) => b.id - a.id);
   
    
    if (sorted_markers.length < 9) {
        missingMarkersNotificationId = notif.warning(WARNINGS.MARKER_INCOMPLETE);
        return;
    } else{
        notif.dismiss(missingMarkersNotificationId);
    }

    let final_marker_area = 0;
    let final_diagonal_ratio = [];    
    let final_orientation_res = []
    for(let i =0; i < 9; i++){
        let marker = sorted_markers[i];
    
        let current_orientation_res = marker_orientation(marker, frameHeight);
        if (current_orientation_res.x != 0 && current_orientation_res.y != 0){
            final_orientation_res.push(current_orientation_res)
        }
        

        final_marker_area = final_marker_area + normalized_marker_area(marker,frameWidth, frameHeight);

        diagonal_ratio(marker,frameWidth, frameHeight,final_diagonal_ratio);
    
       
   
    }
   
    final_marker_area = final_marker_area / sorted_markers.length
    let final_diag_value = Math.min(final_diagonal_ratio[2].y, final_diagonal_ratio[3].x) / Math.max(final_diagonal_ratio[2].y, final_diagonal_ratio[3].x)
    let final_orientation_value = Math.abs(Math.atan2(final_orientation_res[0].x - final_orientation_res[1].x, (final_orientation_res[0].y - final_orientation_res[1].y)))
   

    if ( final_orientation_value> HYPERPARAMETERS.orientation_margin) {
            orientationID = notif.warning(WARNINGS.MARKER_WRONG_ORIENTATION)
     }else{
        notif.dismiss(orientationID);
     }

     
     if (final_diag_value < HYPERPARAMETERS.minimum_diagonal_ratio_min || final_diag_value > HYPERPARAMETERS.minimum_diagonal_ratio_max) {
       
        diagonalID = notif.warning(WARNINGS.MARKER_SKEWED)
     }
     else{
        notif.dismiss(diagonalID);
     }
    
     if (Math.abs(final_marker_area) < HYPERPARAMETERS.minimum_marker_area) {
            normalizedAreaId = notif.warning(WARNINGS.MARKER_TOO_SMALL)
     }else{
        notif.dismiss(normalizedAreaId);
     }
    
     
}

function normalized_marker_area(marker, frameWidth, frameHeight){
    const corners = marker.corners;
    let x_sorted = structuredClone(corners)
    let y_sorted = structuredClone(corners)
    // console.log("here",x_sorted)
    x_sorted.sort((cornerA, cornerB) => {
        return cornerA.x - cornerB.x
    })
    y_sorted.sort((cornerA, cornerB) => {
        return cornerA.y - cornerB.y
    })
    const width = Math.abs(x_sorted.at(-1).x - x_sorted.at(0).x)
    const height = Math.abs(y_sorted.at(-1).y - y_sorted.at(0).y)

    return ((width * height) / (frameWidth * frameHeight))
}

function diagonal_ratio(marker, frameWidth, frameHeight, final_res){
    const corners = marker.corners;
    if (marker.id == 8){
        let x_sorted = [...corners].sort((cornerA, cornerB) => cornerA.x - cornerB.x )
        
        final_res.push(x_sorted[0])
        return 
    } else if(marker.id == 6){
        let y_sorted =  [...corners].sort((cornerA, cornerB) => cornerA.y - cornerB.y )
        final_res.push(y_sorted[0])
    } else if (marker.id == 2){
        let y_sorted =  [...corners].sort((cornerA, cornerB) => cornerB.y - cornerA.y )
        let first_ = y_sorted[0]
        let second_ = final_res[1]
        let distance =  Math.sqrt(Math.pow(first_.x - second_.x, 2) + Math.pow(first_.y - second_.y, 2))
        final_res.push({x:-1, y: distance/frameHeight})
    }
    else if (marker.id == 0){
        let x_sorted =  [...corners].sort((cornerA, cornerB) => cornerB.y - cornerA.y )
        let first_ = x_sorted[0]
        let second_ = final_res[0]
        let distance =  Math.sqrt(Math.pow(first_.x - second_.x, 2) + Math.pow(first_.y - second_.y, 2))
        final_res.push({x:distance/frameWidth, y: -1})
    }


}

function marker_orientation(marker, frameHeight){
    
    if (marker.id != 2 && marker.id != 6){
        return {
            x: 0,
            y: 0
        };
    }

    //head 
    let corners = marker.corners;
    let center = {
        x:(corners[1].x + corners[3].x)/2,
        y: (corners[1].y + corners[3].y)/2
    }
    let res = {
        x: (center.x / frameHeight),
        y:(center.y / frameHeight)
    }

    return res
}



export {NonVisibleMarks}