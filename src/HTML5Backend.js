import defaults from 'lodash/defaults';
import shallowEqual from './shallowEqual';
import EnterLeaveCounter from './EnterLeaveCounter';
import { isFirefox } from './BrowserDetector';
import { getNodeClientOffset, getEventClientOffset, getDragPreviewOffset } from './OffsetUtils';
import { createNativeDragSource, matchNativeItemType } from './NativeDragSources';
import * as NativeTypes from './NativeTypes';

export default class HTML5Backend {
  constructor(manager) {
    this.actions = manager.getActions();
    this.monitor = manager.getMonitor();
    this.registry = manager.getRegistry();

    this.sourcePreviewNodes = {};
    this.sourcePreviewNodeOptions = {};
    this.sourceNodes = {};
    this.sourceNodeOptions = {};
    this.enterLeaveCounter = new EnterLeaveCounter();

    this.getSourceClientOffset = this.getSourceClientOffset.bind(this);
    this.handleTopDragStart = this.handleTopDragStart.bind(this);
    this.handleTopDragStartCapture = this.handleTopDragStartCapture.bind(this);
    this.handleTopDragEndCapture = this.handleTopDragEndCapture.bind(this);
    this.handleTopDragEnter = this.handleTopDragEnter.bind(this);
    this.handleTopDragEnterCapture = this.handleTopDragEnterCapture.bind(this);
    this.handleTopDragLeaveCapture = this.handleTopDragLeaveCapture.bind(this);
    this.handleTopDragOver = this.handleTopDragOver.bind(this);
    this.handleTopDragOverCapture = this.handleTopDragOverCapture.bind(this);
    this.handleTopDrop = this.handleTopDrop.bind(this);
    this.handleTopDropCapture = this.handleTopDropCapture.bind(this);
    this.handleSelectStart = this.handleSelectStart.bind(this);
    this.endDragIfSourceWasRemovedFromDOM = this.endDragIfSourceWasRemovedFromDOM.bind(this);
    this.endDragNativeItem = this.endDragNativeItem.bind(this);
    this.asyncEndDragNativeItem = this.asyncEndDragNativeItem.bind(this);
  }

  setup() {
    // We can set this field on window to enable backend to use a customized window service
    this.windowService = window.__ReactDndHTML5BackendWindow ? window.__ReactDndHTML5BackendWindow : window;

    if (typeof this.windowService === 'undefined') {
      return;
    }

    if (this.constructor.isSetUp) {
      throw new Error('Cannot have two HTML5 backends at the same time.');
    }
    this.constructor.isSetUp = true;
    this.addEventListeners(this.windowService);
  }

  teardown() {
    if (typeof this.windowService === 'undefined') {
      return;
    }

    this.constructor.isSetUp = false;
    this.removeEventListeners(this.windowService);
    this.clearCurrentDragSourceNode();
    if (this.asyncEndDragFrameId) {
      this.windowService.cancelAnimationFrame(this.asyncEndDragFrameId);
    }
  }

  addEventListeners(target) {
    target.addEventListener('dragstart', this.handleTopDragStart);
    target.addEventListener('dragstart', this.handleTopDragStartCapture, true);
    target.addEventListener('dragend', this.handleTopDragEndCapture, true);
    target.addEventListener('dragenter', this.handleTopDragEnter);
    target.addEventListener('dragenter', this.handleTopDragEnterCapture, true);
    target.addEventListener('dragleave', this.handleTopDragLeaveCapture, true);
    target.addEventListener('dragover', this.handleTopDragOver);
    target.addEventListener('dragover', this.handleTopDragOverCapture, true);
    target.addEventListener('drop', this.handleTopDrop);
    target.addEventListener('drop', this.handleTopDropCapture, true);
  }

  removeEventListeners(target) {
    target.removeEventListener('dragstart', this.handleTopDragStart);
    target.removeEventListener('dragstart', this.handleTopDragStartCapture, true);
    target.removeEventListener('dragend', this.handleTopDragEndCapture, true);
    target.removeEventListener('dragenter', this.handleTopDragEnter);
    target.removeEventListener('dragenter', this.handleTopDragEnterCapture, true);
    target.removeEventListener('dragleave', this.handleTopDragLeaveCapture, true);
    target.removeEventListener('dragover', this.handleTopDragOver);
    target.removeEventListener('dragover', this.handleTopDragOverCapture, true);
    target.removeEventListener('drop', this.handleTopDrop);
    target.removeEventListener('drop', this.handleTopDropCapture, true);
  }

  connectDragPreview(sourceId, node, options) {
    this.sourcePreviewNodeOptions[sourceId] = options;
    this.sourcePreviewNodes[sourceId] = node;

    return () => {
      delete this.sourcePreviewNodes[sourceId];
      delete this.sourcePreviewNodeOptions[sourceId];
    };
  }

  connectDragSource(sourceId, node, options) {
    this.sourceNodes[sourceId] = node;
    this.sourceNodeOptions[sourceId] = options;

    const handleDragStart = (e) => this.handleDragStart(e, sourceId);
    const handleSelectStart = (e) => this.handleSelectStart(e, sourceId);

    node.setAttribute('draggable', true);
    node.addEventListener('dragstart', handleDragStart);
    node.addEventListener('selectstart', handleSelectStart);

    return () => {
      delete this.sourceNodes[sourceId];
      delete this.sourceNodeOptions[sourceId];

      node.removeEventListener('dragstart', handleDragStart);
      node.removeEventListener('selectstart', handleSelectStart);
      node.setAttribute('draggable', false);
    };
  }

  connectDropTarget(targetId, node) {
    const handleDragEnter = (e) => this.handleDragEnter(e, targetId);
    const handleDragOver = (e) => this.handleDragOver(e, targetId);
    const handleDrop = (e) => this.handleDrop(e, targetId);

    node.addEventListener('dragenter', handleDragEnter);
    node.addEventListener('dragover', handleDragOver);
    node.addEventListener('drop', handleDrop);

    return () => {
      node.removeEventListener('dragenter', handleDragEnter);
      node.removeEventListener('dragover', handleDragOver);
      node.removeEventListener('drop', handleDrop);
    };
  }

  getCurrentSourceNodeOptions() {
    const sourceId = this.monitor.getSourceId();
    const sourceNodeOptions = this.sourceNodeOptions[sourceId];

    return defaults(sourceNodeOptions || {}, {
      dropEffect: 'move'
    });
  }

  getCurrentDropEffect() {
    if (this.isDraggingNativeItem()) {
      // It makes more sense to default to 'copy' for native resources
      return 'copy';
    }

    return this.getCurrentSourceNodeOptions().dropEffect;
  }

  getCurrentSourcePreviewNodeOptions() {
    const sourceId = this.monitor.getSourceId();
    const sourcePreviewNodeOptions = this.sourcePreviewNodeOptions[sourceId];

    return defaults(sourcePreviewNodeOptions || {}, {
      anchorX: 0.5,
      anchorY: 0.5,
      captureDraggingState: false
    });
  }

  getSourceClientOffset(sourceId) {
    return getNodeClientOffset(this.sourceNodes[sourceId]);
  }

  isDraggingNativeItem() {
    const itemType = this.monitor.getItemType();
    return Object.keys(NativeTypes).some(
      key => NativeTypes[key] === itemType
    );
  }

  beginDragNativeItem(type) {
    this.clearCurrentDragSourceNode();

    const SourceType = createNativeDragSource(type);
    this.currentNativeSource = new SourceType();
    this.currentNativeHandle = this.registry.addSource(type, this.currentNativeSource);
    this.actions.beginDrag([this.currentNativeHandle]);

    // On Firefox, if mouseover fires, the drag is over but browser failed to tell us.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=656164
    // This is not true for other browsers.
    if (isFirefox()) {
      this.windowService.addEventListener('mouseover', this.asyncEndDragNativeItem, true);
    }
  }

  asyncEndDragNativeItem() {
    this.asyncEndDragFrameId = this.windowService.requestAnimationFrame(this.endDragNativeItem);
    if (isFirefox()) {
      this.windowService.removeEventListener('mouseover', this.asyncEndDragNativeItem, true);
      this.enterLeaveCounter.reset();
    }
  }

  endDragNativeItem() {
    if (!this.isDraggingNativeItem()) {
      return;
    }

    this.actions.endDrag();
    this.registry.removeSource(this.currentNativeHandle);
    this.currentNativeHandle = null;
    this.currentNativeSource = null;
  }

  endDragIfSourceWasRemovedFromDOM() {
    const node = this.currentDragSourceNode;
    if (document.body.contains(node)) {
      return;
    }

    if (this.clearCurrentDragSourceNode()) {
      this.actions.endDrag();
    }
  }

  setCurrentDragSourceNode(node) {
    this.clearCurrentDragSourceNode();
    this.currentDragSourceNode = node;
    this.currentDragSourceNodeOffset = getNodeClientOffset(node);
    this.currentDragSourceNodeOffsetChanged = false;

    // Receiving a mouse event in the middle of a dragging operation
    // means it has ended and the drag source node disappeared from DOM,
    // so the browser didn't dispatch the dragend event.
    this.windowService.addEventListener('mousemove', this.endDragIfSourceWasRemovedFromDOM, true);
  }

  clearCurrentDragSourceNode() {
    if (this.currentDragSourceNode) {
      this.currentDragSourceNode = null;
      this.currentDragSourceNodeOffset = null;
      this.currentDragSourceNodeOffsetChanged = false;
      this.windowService.removeEventListener('mousemove', this.endDragIfSourceWasRemovedFromDOM, true);
      return true;
    }

    return false;
  }

  checkIfCurrentDragSourceRectChanged() {
    const node = this.currentDragSourceNode;
    if (!node) {
      return false;
    }

    if (this.currentDragSourceNodeOffsetChanged) {
      return true;
    }

    this.currentDragSourceNodeOffsetChanged = !shallowEqual(
      getNodeClientOffset(node),
      this.currentDragSourceNodeOffset
    );

    return this.currentDragSourceNodeOffsetChanged;
  }

  handleTopDragStartCapture() {
    this.clearCurrentDragSourceNode();
    this.dragStartSourceIds = [];
  }

  handleDragStart(e, sourceId) {
    this.dragStartSourceIds.unshift(sourceId);
  }

  handleTopDragStart(e) {
    const { dragStartSourceIds } = this;
    this.dragStartSourceIds = null;

    const clientOffset = getEventClientOffset(e);

    // Avoid crashing if we missed a drop event or our previous drag died
    if (this.monitor.isDragging()) {
      this.actions.endDrag();
    }

    // Don't publish the source just yet (see why below)
    this.actions.beginDrag(dragStartSourceIds, {
      publishSource: false,
      getSourceClientOffset: this.getSourceClientOffset,
      clientOffset
    });

    const { dataTransfer } = e;
    let nativeType = null;
    // Dragging from firefox will sometimes make its dataTransfer object un-readable
    try {
      nativeType = matchNativeItemType(dataTransfer);
    } catch (err) {
      // If it's not readable, we just let it drag. Because we assume that
      // it is a native type and will be picked up in dragenter handler.
      return;
    }

    if (this.monitor.isDragging()) {
      if (typeof dataTransfer.setDragImage === 'function') {
        // Use custom drag image if user specifies it.
        // If child drag source refuses drag but parent agrees,
        // use parent's node as drag image. Neither works in IE though.
        const sourceId = this.monitor.getSourceId();
        const sourceNode = this.sourceNodes[sourceId];
        const dragPreview = this.sourcePreviewNodes[sourceId] || sourceNode;

        // ##NoDragPreview
        // https://app.asana.com/0/750765658990785/1169293839100683
        // https://app.asana.com/0/1149204378422/1119566821863177
        // Don't do anything if dragPreview is undefined, otherwise the application will crash.
        // This occurs rarely and is a known issue: https://github.com/react-dnd/react-dnd/issues/971
        if (dragPreview) {
          const { anchorX, anchorY } = this.getCurrentSourcePreviewNodeOptions();
          const anchorPoint = { anchorX, anchorY };
          const dragPreviewOffset = getDragPreviewOffset(
            sourceNode,
            dragPreview,
            clientOffset,
            anchorPoint
          );
          dataTransfer.setDragImage(dragPreview, dragPreviewOffset.x, dragPreviewOffset.y);
        }
      }

      try {
        // Firefox won't drag without setting data
        dataTransfer.setData('application/json', {});
      } catch (err) {
        // IE doesn't support MIME types in setData
      }

      // Store drag source node so we can check whether
      // it is removed from DOM and trigger endDrag manually.
      this.setCurrentDragSourceNode(e.target);

      // Now we are ready to publish the drag source.. or are we not?
      const { captureDraggingState } = this.getCurrentSourcePreviewNodeOptions();
      if (!captureDraggingState) {
        // Usually we want to publish it in the next tick so that browser
        // is able to screenshot the current (not yet dragging) state.
        //
        // It also neatly avoids a situation where render() returns null
        // in the same tick for the source element, and browser freaks out.
        setTimeout(() => this.actions.publishDragSource());
      } else {
        // In some cases the user may want to override this behavior, e.g.
        // to work around IE not supporting custom drag previews.
        //
        // When using a custom drag layer, the only way to prevent
        // the default drag preview from drawing in IE is to screenshot
        // the dragging state in which the node itself has zero opacity
        // and height. In this case, though, returning null from render()
        // will abruptly end the dragging, which is not obvious.
        //
        // This is the reason such behavior is strictly opt-in.
        this.actions.publishDragSource();
      }
    } else if (nativeType) {
      // A native item (such as URL) dragged from inside the document
      this.beginDragNativeItem(nativeType);
    } else if (
      !dataTransfer.types && (
        !e.target.hasAttribute ||
        !e.target.hasAttribute('draggable')
      )
    ) {
      // Looks like a Safari bug: dataTransfer.types is null, but there was no draggable.
      // Just let it drag. It's a native type (URL or text) and will be picked up in dragenter handler.
      return;
    } else {
      // If by this time no drag source reacted, tell browser not to drag.
      e.preventDefault();
    }
  }

  handleTopDragEndCapture() {
    if (this.clearCurrentDragSourceNode()) {
      // Firefox can dispatch this event in an infinite loop
      // if dragend handler does something like showing an alert.
      // Only proceed if we have not handled it already.
      this.actions.endDrag();
    }
  }

  handleTopDragEnterCapture(e) {
    this.dragEnterTargetIds = [];

    const isFirstEnter = this.enterLeaveCounter.enter(e.target);
    if (!isFirstEnter || this.monitor.isDragging()) {
      return;
    }

    const { dataTransfer } = e;
    const nativeType = matchNativeItemType(dataTransfer);

    if (nativeType) {
      // A native item (such as file or URL) dragged from outside the document
      this.beginDragNativeItem(nativeType);
    }
  }

  handleDragEnter(e, targetId) {
    this.dragEnterTargetIds.unshift(targetId);
  }

  handleTopDragEnter(e) {
    const { dragEnterTargetIds } = this;
    this.dragEnterTargetIds = [];

    if (!this.monitor.isDragging()) {
      // This is probably a native item type we don't understand.
      return;
    }

    if (!isFirefox()) {
      // Don't emit hover in `dragenter` on Firefox due to an edge case.
      // If the target changes position as the result of `dragenter`, Firefox
      // will still happily dispatch `dragover` despite target being no longer
      // there. The easy solution is to only fire `hover` in `dragover` on FF.
      this.actions.hover(dragEnterTargetIds, {
        clientOffset: getEventClientOffset(e)
      });
    }

    const canDrop = dragEnterTargetIds.some(
      targetId => this.monitor.canDropOnTarget(targetId)
    );

    if (canDrop) {
      // IE requires this to fire dragover events
      e.preventDefault();
      e.dataTransfer.dropEffect = this.getCurrentDropEffect();
    }
  }

  handleTopDragOverCapture() {
    this.dragOverTargetIds = [];
  }

  handleDragOver(e, targetId) {
    this.dragOverTargetIds.unshift(targetId);
  }

  handleTopDragOver(e) {
    const { dragOverTargetIds } = this;
    this.dragOverTargetIds = [];

    if (!this.monitor.isDragging()) {
      // This is probably a native item type we don't understand.
      // Prevent default "drop and blow away the whole document" action.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    this.actions.hover(dragOverTargetIds, {
      clientOffset: getEventClientOffset(e)
    });

    const canDrop = dragOverTargetIds.some(
      targetId => this.monitor.canDropOnTarget(targetId)
    );

    if (canDrop) {
      // Show user-specified drop effect.
      e.preventDefault();
      e.dataTransfer.dropEffect = this.getCurrentDropEffect();
    } else if (this.isDraggingNativeItem()) {
      // Don't show a nice cursor but still prevent default
      // "drop and blow away the whole document" action.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    } else if (this.checkIfCurrentDragSourceRectChanged()) {
      // Prevent animating to incorrect position.
      // Drop effect must be other than 'none' to prevent animation.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }

  handleTopDragLeaveCapture(e) {
    if (this.isDraggingNativeItem()) {
      // ##FirefoxPermissionDenied
      // In Firefox sometimes preventDefault is not accessible on e. This adds
      // temporary logging so hopefully we will learn more about this error.
      // https://app.asana.com/0/1149204378422/334924376407244
      try {
        e.preventDefault();
      } catch (err) {
        host && host.recordWarning && host.recordWarning( // eslint-disable-line
          'Error when trying to access e.preventDefault in handleTopDragLeaveCapture',
          this.monitor.getItemType()
        );
      }
    }

    let isLastLeave = false;
    // #FirefoxPermissionDenied
    try {
      isLastLeave = this.enterLeaveCounter.leave(e.target);
    } catch (err) {
      host && host.recordWarning && host.recordWarning( // eslint-disable-line
        'Error when trying to access e.target in handleTopDragLeaveCapture',
        this.monitor.getItemType()
      );
    }
    if (!isLastLeave) {
      return;
    }

    if (this.isDraggingNativeItem()) {
      this.endDragNativeItem();
    }
  }

  handleTopDropCapture(e) {
    this.dropTargetIds = [];
    e.preventDefault();

    if (this.isDraggingNativeItem()) {
      this.currentNativeSource.mutateItemByReadingDataTransfer(e.dataTransfer);
    }

    this.enterLeaveCounter.reset();
  }

  handleDrop(e, targetId) {
    this.dropTargetIds.unshift(targetId);
  }

  handleTopDrop(e) {
    const { dropTargetIds } = this;
    this.dropTargetIds = [];

    // Avoid crashing if we are not dragging anything
    if (!this.monitor.isDragging()) {
      return;
    }

    this.actions.hover(dropTargetIds, {
      clientOffset: getEventClientOffset(e)
    });
    this.actions.drop();

    if (this.isDraggingNativeItem()) {
      this.endDragNativeItem();
    } else {
      this.endDragIfSourceWasRemovedFromDOM();
    }
  }

  handleSelectStart(e) {
    const { target } = e;

    // Only IE requires us to explicitly say
    // we want drag drop operation to start
    if (typeof target.dragDrop !== 'function') {
      return;
    }

    // Inputs and textareas should be selectable
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return;
    }

    // For other targets, ask IE
    // to enable drag and drop
    e.preventDefault();
    target.dragDrop();
  }
}
