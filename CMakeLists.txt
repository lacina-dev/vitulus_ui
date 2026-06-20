################################################################################
# Set minimum required version of cmake, project name and compile options
################################################################################
cmake_minimum_required(VERSION 3.0.2)
project(vitulus_ui)

## Compile as C++11, supported in ROS Kinetic and newer
add_compile_options(-std=c++11)

################################################################################
# Find catkin packages and libraries for catkin and system dependencies
################################################################################
find_package(catkin REQUIRED COMPONENTS
  roscpp
  rospy
  std_msgs
  message_generation
)

################################################################################
# Setup for python modules and scripts
################################################################################
catkin_python_setup()

################################################################################
# Declare ROS messages, services and actions
################################################################################
#add_message_files(
#  FILES
#  vitulus_ups.msg
#)

#generate_messages(
#  DEPENDENCIES
#  std_msgs
#)
################################################################################
# Declare ROS dynamic reconfigure parameters
################################################################################

################################################################################
# Declare catkin specific configuration to be passed to dependent projects
################################################################################
catkin_package(
  CATKIN_DEPENDS roscpp rospy std_msgs message_runtime
)

################################################################################
# Build
################################################################################
include_directories(
  ${catkin_INCLUDE_DIRS}
)



################################################################################
# Install
################################################################################





install(DIRECTORY launch
  DESTINATION ${CATKIN_PACKAGE_SHARE_DESTINATION}
)


catkin_install_python(PROGRAMS
  nodes/webnode
  nodes/status_logger
  DESTINATION ${CATKIN_PACKAGE_BIN_DESTINATION}
)

################################################################################
# Test
################################################################################
