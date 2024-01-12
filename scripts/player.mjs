/*
Aktuell geht das Extrahieren und Anzeigen von Parts nicht.
Bei komplexen Parts (z.B. Brick mit seitlichem Pin) werden diese teilweise
als separate Parts identifiziert.
Da diese separaten Parts denselben BuildingStep haben, spielt das bei der Anzeige
im Gesamtkontext keine Rolle. Jedoch kann nicht erkannt werden, ob es sich um zwei separate
Parts oder ein einziges Part mit Unterelementen handelt.
Das ist entweder ein Problem im LDrawLoader oder in der Definition der LDraw-DAT-Dateien.

Das Problem ließ sich lösen, indem alle Kindelemente des Modells selbst als Root-Gruppen markiert wurden
und nur diese als Parts extrahiert werden.
Das hat aber zur Folge, dass bei der Erstellung von LDraw-Dateien NICHT mit Submodellen gearbeitet werden darf!
*/

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'; 

let threeScene; // Referenz auf ThreeJS Szene
let renderer; // Referenz auf den ThreeJS renderer
let camera; // Aktuell angezeigte ThreeJS Kamera
let controls; // Oribit Controls zum Festlegen der Initialien Ausrichtung
let currentStep; // Aktueller Schritt
let currentModel;
let showLines = true;
let moveStep = 20;
let smallScale = 0.0004;
let bigScale = 0.01;
let currentRotation = 0;

let xrSession;
let xrLocalReferenceSpace;
let xrHitTestSource;
let xrHitTestSourceRequested = false;
let xrRectile;
let xrModelPlaced = false;

let lDrawLoader;
let rootGroup;
let gameControllers;
let controllersBefore = { 
  left: { 
    axes: { left: false, right: false, up: false, down: false }, 
    buttons: { trigger: false, grip: false, xButton: false, yButton: false }
  },
  right: { 
    axes: { left: false, right: false, up: false, down: false }, 
    buttons: { trigger: false, grip: false, aButton: false, bButton: false }
  },
};

let placeHolderLineMaterial = new THREE.LineBasicMaterial( { color: 0xFF99CC, lineWidth: 1 });
let placeHolderMeshMaterial = new THREE.MeshBasicMaterial( { color: 0xFF99CC, transparent: true, opacity: .5 });

const SaveGameHelper = {
  
  currentSaveGame: null,
  currentUrl: null,
  
  load: function(url) {
    SaveGameHelper.currentUrl = url;
    var text = localStorage.getItem(SaveGameHelper.currentUrl);
    if (text) {
      try {
        // Wenn im localStorage noch alter Mist drin steht, wird im Nachhinein dieser Mist bereinigt
        var json = JSON.parse(text);
        if (typeof json === "object") {
          SaveGameHelper.currentSaveGame = json;
          return SaveGameHelper.currentSaveGame;
        }
      } finally {}
    }
    SaveGameHelper.currentSaveGame = {
      step: 0,
      scale: 0.0004,
      rotation: 0,
    }
    SaveGameHelper.save();
    return SaveGameHelper.currentSaveGame;
  },
  
  save: function() {
    localStorage.setItem(SaveGameHelper.currentUrl, JSON.stringify(SaveGameHelper.currentSaveGame));
  }
  
}

// Von https://wejn.org/2020/12/cracking-the-threejs-object-fitting-nut/
function fitCameraToCenteredObject(camera, object, offset, orbitControls ) {
    const boundingBox = new THREE.Box3();
    boundingBox.setFromObject( object );

    var middle = new THREE.Vector3();
    var size = new THREE.Vector3();
    boundingBox.getSize(size);

    const fov = camera.fov * ( Math.PI / 180 );
    const fovh = 2*Math.atan(Math.tan(fov/2) * camera.aspect);
    let dx = size.z / 2 + Math.abs( size.x / 2 / Math.tan( fovh / 2 ) );
    let dy = size.z / 2 + Math.abs( size.y / 2 / Math.tan( fov / 2 ) );
    let cameraZ = Math.max(dx, dy);

    // offset the camera, if desired (to avoid filling the whole canvas)
    if( offset !== undefined && offset !== 0 ) cameraZ *= offset;

    camera.position.set( cameraZ, cameraZ, cameraZ );

    // set the far plane of the camera so that it easily encompasses the whole object
    const minZ = boundingBox.min.z;
    const cameraToFarEdge = ( minZ < 0 ) ? -minZ + cameraZ : cameraZ - minZ;

    camera.far = cameraToFarEdge * 3;
    camera.updateProjectionMatrix();

    if ( orbitControls !== undefined ) {
        // set camera to rotate around the center
        orbitControls.target = new THREE.Vector3(0, 0, 0);

        // prevent camera from zooming out far enough to create far plane cutoff
        orbitControls.maxDistance = cameraToFarEdge * 2;
    }
}

function updateModelVisibility() {
  // Sichtbarkeit abhaenging vom aktuellen Schritt
  currentModel.traverse( c => {

    if ( c.isLineSegments ) {
      c.visible = showLines;
    } else if ( c.isGroup ) {
      // Hide objects with building step > gui setting
      c.visible = c.userData.buildingStep <= currentStep;
    }

  } );
}

function initXRControllers() {
  const controllerModelFactory = new XRControllerModelFactory();
  gameControllers = [0,1].map(function (index) {
    const controller = renderer.xr.getController(index);
    controller.addEventListener("connected", (e) => {
      controller.gamepad = e.data.gamepad;
      controller.controllerGrip = renderer.xr.getControllerGrip(index);
      const model = controllerModelFactory.createControllerModel(controller.controllerGrip);
      controller.controllerGrip.add(model);
      threeScene.add(controller.controllerGrip);
    });
    return controller;
  });
}

async function initAR() {
  if (navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')) {
    var arOverlay = document.querySelector(".aroverlay");
    // AR beenden
    document.querySelector(".aroverlay button.back").addEventListener("click", () => {
      arOverlay.style.display = "none";
      xrSession.end();
      location.reload();
    });
    // AR starten
    var arButton = document.querySelector("button.icon.ar");
    arButton.style.display = "block";
    arButton.addEventListener("click", async () => {
      // AR-Sitzung anfordern
      xrSession = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: arOverlay }});
      renderer.autoClear = false;
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType("local");
      // Kamera durchscheinen lassen
      threeScene.background = null;
      await renderer.xr.setSession(xrSession);
      if (xrSession.domOverlayState) {
        arOverlay.style.display = "block";
        // Buttons umhängen
        arOverlay.appendChild(document.querySelector("#playpage button.lines"));
        arOverlay.appendChild(document.querySelector("#playpage button.stepup"));
        arOverlay.appendChild(document.querySelector("#playpage button.stepdown"));
      }
      var saveGame = SaveGameHelper.currentSaveGame;
      // Ziel-Ring für Positionierung erstellen
      xrRectile = new THREE.Mesh(new THREE.RingGeometry( 0.15, 0.2, 32 ).rotateX( - Math.PI / 2 ), new THREE.MeshBasicMaterial());
      xrRectile.matrixAutoUpdate = false;
      xrRectile.visible = false;
      threeScene.add(xrRectile);
      // Controller für VR Headsets initialisieren
      initXRControllers();
    });
  }
}

function handleControllerInput() {
  if (!gameControllers || gameControllers.length < 2) return;
  var leftGamePad = gameControllers[0].gamepad;
  var rightGamePad = gameControllers[1].gamepad;
  if (!leftGamePad || !rightGamePad || leftGamePad.axes.length < 4 || leftGamePad.buttons.length < 6 || rightGamePad.axes.length < 4 || rightGamePad.buttons.length < 6) return;
  // Zuordnung siehe https://github.com/immersive-web/webxr-input-profiles/blob/main/packages/registry/profiles/oculus/oculus-touch-v2.json
  var controllersCurrently = {
    left: { 
      axes: { left: leftGamePad.axes[2] < -.5, right: leftGamePad.axes[2] > .5, up: leftGamePad.axes[3] < -.5, down: leftGamePad.axes[3] > .5 }, 
      buttons: { trigger: leftGamePad.buttons[0].pressed, grip: leftGamePad.buttons[1].pressed, xButton: leftGamePad.buttons[4].pressed, yButton: leftGamePad.buttons[5].pressed }
    },
    right: { 
      axes: { left: rightGamePad.axes[2] < -.5, right: rightGamePad.axes[2] > .5, up: rightGamePad.axes[3] < -.5, down: rightGamePad.axes[3] > .5 }, 
      buttons: { trigger: rightGamePad.buttons[0].pressed, grip: rightGamePad.buttons[1].pressed, aButton: rightGamePad.buttons[4].pressed, bButton: rightGamePad.buttons[5].pressed }
    },
  };
  /*
  // Änderung prüfen
  // Links
  if (controllersCurrently.left.axes.left && !controllersBefore.left.axes.left) { console.log("LEFT left"); Player.moveLeft(); }
  if (controllersCurrently.left.axes.right && !controllersBefore.left.axes.right) { console.log("LEFT right"); Player.moveRight(); }
  if (controllersCurrently.left.axes.up && !controllersBefore.left.axes.up) { console.log("LEFT up"); Player.moveForward(); }
  if (controllersCurrently.left.axes.down && !controllersBefore.left.axes.down) { console.log("LEFT down"); Player.moveBackward(); }
  if (controllersCurrently.left.buttons.trigger && !controllersBefore.left.buttons.trigger) { console.log("LEFT trigger"); Player.moveUp(); }
  if (controllersCurrently.left.buttons.grip && !controllersBefore.left.buttons.grip) { console.log("LEFT grip"); Player.moveDown(); }
  if (controllersCurrently.left.buttons.xButton && !controllersBefore.left.buttons.xButton) { console.log("LEFT xButton"); Player.toggleLines(); }
  if (controllersCurrently.left.buttons.yButton && !controllersBefore.left.buttons.yButton) { console.log("{ LEFT yButton"); }
  // Rechts
  if (controllersCurrently.right.axes.left && !controllersBefore.right.axes.left) { console.log("RIGHT left"); Player.rotateLeft(); }
  if (controllersCurrently.right.axes.right && !controllersBefore.right.axes.right) { console.log("RIGHT right"); Player.rotateRight(); }
  if (controllersCurrently.right.axes.up && !controllersBefore.right.axes.up) { console.log("RIGHT up"); Player.stepUp(); }
  if (controllersCurrently.right.axes.down && !controllersBefore.right.axes.down) { console.log("RIGHT down"); Player.stepDown(); }
  if (controllersCurrently.right.buttons.trigger && !controllersBefore.right.buttons.trigger) { console.log("RIGHT trigger"); }
  if (controllersCurrently.right.buttons.grip && !controllersBefore.right.buttons.grip) { console.log("RIGHT grip"); }
  if (controllersCurrently.right.buttons.aButton && !controllersBefore.right.buttons.aButton) { console.log("RIGHT aButton"); Player.makeSmaller(); }
  if (controllersCurrently.right.buttons.bButton && !controllersBefore.right.buttons.bButton) { console.log("RIGHT bButton"); Player.makeBigger(); }
  */
  controllersBefore = controllersCurrently;
}

// AR Marker zum Positionieren anzeigen und bewegen
async function handleXRSession(frame) {
  if (xrModelPlaced) return;
  if (frame) {
    xrLocalReferenceSpace = renderer.xr.getReferenceSpace();
    if (!xrHitTestSourceRequested) {
      var viewerSpace = await xrSession.requestReferenceSpace("viewer");
      xrHitTestSource = await xrSession.requestHitTestSource({space: viewerSpace});
      xrHitTestSourceRequested = true;
    }
    if (xrHitTestSource) {
      var hitTestResults = frame.getHitTestResults(xrHitTestSource);
      if (hitTestResults.length > 0) {
        var hit = hitTestResults[0];
        var pose = hit.getPose(xrLocalReferenceSpace);
        xrRectile.visible = true;
        xrRectile.matrix.fromArray(pose.transform.matrix);
        xrRectile.matrix.decompose(currentModel.position);
      } else {
        xrRectile.visible = false;
      }
    }
  }
}

function handleRotation() {
  if (currentModel && currentRotation) currentModel.rotation.y = (currentModel.rotation.y + currentRotation) % (Math.PI * 2);
}

// Globales Objekt, welches den 3D Player beinhaltet und managt
const Player = {

  // Player initialisieren und ThreeJS starten, vorher müssen Event listener angehängt werden
  // targetElement gibt das DOM Element an, an welches der Renderer als Kind angehängt wird
  init: function (targetElement) {
    document.querySelector('.progressbar').classList.remove('invisible');
    // Initialize ThreeJS
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0xE6F1FF);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    camera = new THREE.PerspectiveCamera(45, 1, .001, 1000);
    camera.position.set(4, 4, 4);
    // Orbit Controls vorbereiten, benötigen Animation loop
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controls.rotateSpeed = 0.4;
    controls.panSpeed = 0.4;
    controls.screenSpacePanning = true;
    controls.minDistance = 2;
    controls.maxDistance = 100;
    // Umgebungslicht
    threeScene.add(new THREE.AmbientLight(0x222222));
    // Taschenlampe
    var pointLight = new THREE.PointLight(0xffffff, 4, 0, 0);
    pointLight.position.set(0, 0, 0);
    camera.add(pointLight);
    // Die Kamera darf erst dann zur Szene hinzugefügt werden, wenn alle Kindelemente angehängt sind
    threeScene.add(camera);
    // Event Listener für Fenstergröße, Maus und Touch registrieren
    window.addEventListener('resize', onWindowResize, false);
    window.addEventListener("orientationchange", onWindowResize, false);
    // Renderer in DOM einfügen
    targetElement.appendChild(renderer.domElement);
    onWindowResize();
    // AR und XR vorbereiten
    initAR();
    // Animation loop starten und Renderer-Größe ermitteln lassen
    renderer.setAnimationLoop(function (timestamp, frame) {
      handleControllerInput();
      handleRotation();
      if (xrSession) handleXRSession(frame);
      controls.update();
      renderer.render(threeScene, camera);
    });
  },

  // Bereinigt die Szene und lädt das angegebene Modell
  loadModel: function (modelUrl, callback) {
    var saveGame = SaveGameHelper.load(modelUrl);
    lDrawLoader = new LDrawLoader();
    lDrawLoader.smoothNormals = true;
    lDrawLoader
      .setPath( '' )
      .setPartsLibraryPath('https://hilderonny.github.io/flat-ldraw-parts/')
      .load( modelUrl, function ( model ) {
      
        currentModel = model;
        currentModel.modelUrl = modelUrl; // For localstorage

        // Convert from LDraw coordinates: rotate 180 degrees around OX
        currentModel.rotation.x = Math.PI;
      
        currentModel.scale.multiplyScalar(.01);

        threeScene.add(currentModel);

        currentStep = saveGame.step;
      
        updateModelVisibility();
      
        document.querySelector('.progressbar').classList.add('invisible');
        onWindowResize(); // Muss aufgerufen werden, nachdem die Progressbar verschwunden ist
      
        if (callback) callback();
      
      } );
  },
  
  getCurrentStep: function() {
    return currentStep;
  },
  
  getModel: function() {
    return currentModel;
  },
  
  getRootGroup: function() {
    return rootGroup;
  },
  
  getStepCount: function() {
    return currentModel.userData.numBuildingSteps;
  },
  
  setCurrentStep: function(step) {
    currentStep = step;
    SaveGameHelper.currentSaveGame.step = step;
    SaveGameHelper.save();
    updateModelVisibility();
  },
  
  toggleLines: function() {
    showLines = !showLines;
    updateModelVisibility();
  },
  
  stepUp: function() {
    if (currentStep < currentModel.userData.numBuildingSteps - 1) {
      Player.setCurrentStep(currentStep + 1);
    }
  },

  stepDown: function() {
    if (currentStep > 0) {
      Player.setCurrentStep(currentStep - 1);
    }
  },

  moveUp: function() {
    xrModelPlaced = false;
  },

  moveDown: function() {
    xrModelPlaced = true;
    xrRectile.visible = false;
  },

  setScale: function(scale) {
    currentModel.scale.set(scale, scale, scale);
    SaveGameHelper.currentSaveGame.scale = scale;
    SaveGameHelper.save();
  },

  makeSmaller: function() {
    Player.setScale(smallScale);
  },

  makeBigger: function() {
    Player.setScale(bigScale);
  },
  
  setRotation: function(rotation) {
    currentRotation = rotation;
  },
  
  rotateLeft: function() {
    currentModel.rotation.y -= Math.PI / 4;
    SaveGameHelper.currentSaveGame.rotation = currentModel.rotation.y;
    SaveGameHelper.save();
  },
  
  rotateRight: function() {
    currentModel.rotation.y += Math.PI / 4;
    SaveGameHelper.currentSaveGame.rotation = currentModel.rotation.y;
    SaveGameHelper.save();
  }

};

// Berechnet die Projektsionsmatrix und das Screen-Verhältnis neu, wenn sich die Fenstergröße ändert
function onWindowResize() {
    renderer.setSize(100, 100); // Nur so wird die Größe des übergeordneten Elements richtig brechnet
    const width = renderer.domElement.parentNode.offsetWidth;
    const height = renderer.domElement.parentNode.offsetHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

export { Player, SaveGameHelper };